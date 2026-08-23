Feature: Data table and doc string

  Scenario: a step with a data table
    Given a step with the following table:
      | name  | role  |
      | Alice | admin |
      | Bob   | user  |

  Scenario: a step with a doc string
    Given a step with the following text:
      """
      hello from a doc string
      """
