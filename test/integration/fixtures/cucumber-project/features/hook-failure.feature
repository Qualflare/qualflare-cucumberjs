Feature: Hook failure

  @hook-failure
  Scenario: never runs its body because the guarding Before hook fails first
    Given a step that never runs
