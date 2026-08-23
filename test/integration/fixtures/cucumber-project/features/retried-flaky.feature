Feature: Retried flaky scenario

  @flaky
  Scenario: is flaky and eventually passes
    Given a step that fails once then passes
