Feature: Checkout

  Scenario Outline: applies a discount code
    Given a cart total of <total>
    When the discount code "<code>" is applied
    Then the final total is <final>

    Examples:
      | total | code     | final |
      | 100   | SAVE10   | 90    |
      | 50    | SAVE10   | 45    |
