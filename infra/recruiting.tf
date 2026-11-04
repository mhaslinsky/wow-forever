resource "aws_cloudwatch_metric_alarm" "recruiting_error" {
  alarm_name          = "wow-forever-recruiting-error"
  namespace           = "wow-forever/recruiting"
  metric_name         = "RecruitingError"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
