# Flow A sketch — planner ⇄ review loop, then implement → adversary → repair. Uses an automated
# gate (reviewer_pass); the interactive `user_accept` variant is rejected at load in S2. Parses and
# re-emits for format completeness (Subsystem 5 draws this); it does not run in S2.
flow "flow-a" {
  label = "Idea → plan ⇄ review → implement → adversary → repair"

  loop {
    stages = ["planner", "reviewer"]
    until  = "reviewer_pass"
    max    = 3
  }

  stage {
    name  = "implementer"
    model = "sonnet"
  }
  stage {
    name  = "adversary"
    model = "opus"
  }
  stage {
    name  = "repairer"
    model = "sonnet"
  }
}
