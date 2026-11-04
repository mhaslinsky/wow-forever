data "aws_iam_policy_document" "needs_roster_index" {
  statement {
    actions   = ["dynamodb:Query"]
    resources = ["${aws_dynamodb_table.guild.arn}/index/gsi1"]
  }
}
resource "aws_iam_role_policy" "needs_roster_index" {
  name   = "wow-forever-needs-roster-index"
  role   = aws_iam_role.gateway.id
  policy = data.aws_iam_policy_document.needs_roster_index.json
}
