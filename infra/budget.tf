resource "aws_sns_topic" "alerts" { name = "wow-forever-alerts" }
data "aws_iam_policy_document" "budget_publish" {
  statement {
    sid       = "CloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudwatch:us-east-1:${var.aws_account_id}:alarm:*"]
    }
  }
  statement {
    sid       = "Budgets"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:budgets::${var.aws_account_id}:*"]
    }
  }
}
resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.budget_publish.json
}
resource "aws_budgets_budget" "monthly" {
  name         = "wow-forever-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  dynamic "notification" {
    for_each = toset([80, 100])
    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value
      threshold_type            = "PERCENTAGE"
      notification_type         = "ACTUAL"
      subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
      # Budgets sends an actual-spend alert once per period, so email covers a dropped Discord delivery.
      subscriber_email_addresses = [var.budget_alert_email]
    }
  }
  depends_on = [aws_sns_topic_policy.alerts, aws_sns_topic_subscription.alerts_discord]
}
output "alerts_topic_arn" { value = aws_sns_topic.alerts.arn }
