Feature: Scenario outline

  Scenario Outline: adds <a> and <b> to get <sum>
    Given the numbers <a> and <b>
    Then the sum is <sum>

    Examples:
      | a | b | sum |
      | 1 | 2 | 3   |
      | 4 | 5 | 9   |
