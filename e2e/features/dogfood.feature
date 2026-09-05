Feature: Dogfood

  # Every scenario here is meant to PASS. Unlike
  # test/integration/fixtures/cucumber-project, which deliberately fails to
  # exercise status mapping, this suite is uploaded to Qualflare -- so red has
  # to mean a real regression. Status mapping stays that fixture's job; please
  # do not add a failing scenario here.

  Scenario: reports a plain passing scenario
    Given the cart is empty
    When I add 2 "widget" at 2100
    Then the total is 4200

  Scenario: records the author-facing metadata API
    Given a scenario that records every metadata field
    Then the metadata calls did not throw

  Scenario: nests steps
    Given the cart is empty
    When I add 1 "gadget" at 999 inside nested steps
    Then the total is 999

  Scenario: attaches a screenshot
    Given a scenario that attaches a fake screenshot
    Then the attachment call did not throw

  Scenario: redacts a masked parameter
    Given a scenario that records a masked parameter
    Then the metadata calls did not throw

  @flaky
  Scenario: fails once, then passes, producing per-attempt history
    Given a step that fails once then passes
    Then the metadata calls did not throw
