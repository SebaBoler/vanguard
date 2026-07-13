flow "flow-b" {
  label = "Plan → implement → adversary → repair"

  stage {
    name = "planner"
    model = "opus"
    effort = "high"
    max_turns = 10
    resume_previous = false
  }

  stage {
    name = "implementer"
    model = "sonnet"
    max_turns = 30
    resume_previous = false
  }

  stage {
    name = "adversary"
    model = "opus"
    effort = "high"
    max_turns = 12
    resume_previous = false
  }

  stage {
    name = "repairer"
    model = "sonnet"
    max_turns = 20
    resume_previous = false
  }
}
