Feature: Login

  @smoke
  Scenario: signs in with valid credentials
    Given a user with valid credentials
    When they submit the login form
    Then they land on the dashboard
