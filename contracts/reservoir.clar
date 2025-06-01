;; title: reservoir
;; version: 0.6.0
;; summary: A Reservoir is a liquidity pool and hub for StackFlow pipes.
;;
;; MIT License
;;
;; Copyright (c) 2025 obycode, LLC
;;
;; Permission is hereby granted, free of charge, to any person obtaining a copy
;; of this software and associated documentation files (the "Software"), to deal
;; in the Software without restriction, including without limitation the rights
;; to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
;; copies of the Software, and to permit persons to whom the Software is
;; furnished to do so, subject to the following conditions:
;; The above copyright notice and this permission notice shall be included in all
;; copies or substantial portions of the Software.
;; THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
;; IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
;; FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
;; AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
;; LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
;; OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
;; SOFTWARE.

(use-trait sip-010 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)
(use-trait stackflow-token .stackflow-token.stackflow-token)
;; (use-trait stackflow-token 'SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-token-0-6-0.stackflow-token)

(define-constant OPERATOR tx-sender)
(define-constant RESERVOIR (as-contract tx-sender))

;; Error code
(define-constant ERR_BORROW_FEE_PAYMENT_FAILED (err u200))
(define-constant ERR_UNAUTHORIZED (err u201))
(define-constant ERR_FUNDING_FAILED (err u202))
(define-constant ERR_TRANSFER_FAILED (err u203))
(define-constant ERR_INVALID_FEE (err u204))
(define-constant ERR_ALREADY_INITIALIZED (err u205))
(define-constant ERR_NOT_INITIALIZED (err u206))
(define-constant ERR_UNAPPROVED_TOKEN (err u207))
(define-constant ERR_INCORRECT_STACKFLOW (err u208))
(define-constant ERR_AMOUNT_TOO_LOW (err u209))
(define-constant ERR_LIQUIDITY_POOL_FULL (err u210))

;;; Has this contract been initialized?
(define-data-var initialized bool false)

;;; Current borrow rate in basis points (1 = 0.01%)
;;; For example, 1000 = 10%
(define-data-var borrow-rate uint u0)

;;; Current minimum amount for liquidity providers to add to the reservoir
;;; Initially set to 1,000 STX
(define-data-var min-liquidity-amount uint u1000000000)

;;; The token supported by this instance of the Reservoir contract.
;;; If `none`, only STX is supported.
(define-data-var supported-token (optional principal) none)

;;; The StackFlow contract that this Reservoir is registered with.
(define-data-var stackflow-contract (optional principal) none)

;;; The list of providers funding the Reservoir.
(define-data-var providers (list 256 principal) (list))
(define-constant MAX_PROVIDERS u256)

;;; Map of the liquidity provided by each provider.
(define-map liquidity
  principal
  uint
)

(define-public (init
    (stackflow <stackflow-token>)
    (token (optional <sip-010>))
    (initial-borrow-rate uint)
  )
  (begin
    (asserts! (is-eq contract-caller OPERATOR) ERR_UNAUTHORIZED)
    (asserts! (not (var-get initialized)) ERR_ALREADY_INITIALIZED)

    ;; Set the token for this instance of the Reservoir contract.
    (var-set supported-token (contract-of-optional token))

    ;; Set the StackFlow contract for this instance of the Reservoir contract.
    (var-set stackflow-contract (some (contract-of stackflow)))

    ;; Authorize the operator as a StackFlow agent for this contract.
    (try! (as-contract (contract-call? stackflow register-agent OPERATOR)))

    ;; Set the initial borrow rate.
    (var-set borrow-rate initial-borrow-rate)

    ;; Initialize the contract.
    (ok (var-set initialized true))
  )
)

;;; Create a new tap for FT `token` (`none` indicates STX) and deposit
;;; `amount` funds into it.
;;; Returns:
;;; - The pipe key on success
;;;   ```
;;;   { token: (optional principal), principal-1: principal, principal-2: principal }
;;;   ```
;;; - `ERR_NOT_INITIALIZED` if the contract has not been initialized
;;; - `ERR_INCORRECT_STACKFLOW` if the StackFlow contract is not the correct one
;;; - `ERR_UNAPPROVED_TOKEN` if the token is not the correct token
;;; - `ERR_NONCE_TOO_LOW` if the nonce is less than the pipe's saved nonce
;;; - `ERR_CLOSE_IN_PROGRESS` if a forced closure is in progress
;;; - `ERR_ALREADY_FUNDED` if the pipe has already been funded
(define-public (create-tap
    (stackflow <stackflow-token>)
    (token (optional <sip-010>))
    (amount uint)
    (nonce uint)
  )
  (begin
    (try! (check-valid stackflow token))
    (contract-call? stackflow fund-pipe token amount RESERVOIR nonce)
  )
)

;;; Deposit `amount` additional funds into an existing pipe between
;;; `tx-sender` and `with` for FT `token` (`none` indicates STX). Signatures
;;; must confirm the deposit and the new balances.
;;; Returns:
;;; -`(ok pipe-key)` on success
;;; - `ERR_NOT_INITIALIZED` if the contract has not been initialized
;;; - `ERR_INCORRECT_STACKFLOW` if the StackFlow contract is not the correct one
;;; - `ERR_UNAPPROVED_TOKEN` if the token is not the correct token
;;; - `ERR_NO_SUCH_PIPE` if the pipe does not exist
;;; - `ERR_CLOSE_IN_PROGRESS` if a forced closure is in progress
;;; - `ERR_NONCE_TOO_LOW` if the nonce is less than the pipe's saved nonce
;;; - `ERR_INVALID_TOTAL_BALANCE` if the total balance of the pipe is not
;;;   equal to the sum of the balances provided and the deposit amount
;;; - `ERR_INVALID_SENDER_SIGNATURE` if the sender's signature is invalid
;;; - `ERR_INVALID_OTHER_SIGNATURE` if the other party's signature is invalid
;;; - `ERR_DEPOSIT_FAILED` if the deposit fails
(define-public (add-funds
    (stackflow <stackflow-token>)
    (amount uint)
    (token (optional <sip-010>))
    (my-balance uint)
    (their-balance uint)
    (my-signature (buff 65))
    (their-signature (buff 65))
    (nonce uint)
  )
  (begin
    (try! (check-valid stackflow token))
    (contract-call? .stackflow deposit amount token RESERVOIR my-balance
      their-balance my-signature their-signature nonce
    )
  )
)

;;; Borrow `amount` from the reservoir to add receiving capacity to the
;;; caller's tap. The caller pays a fee of `fee` to the reservoir. The caller
;;; provides their own signature for the deposit, as well as a signature that
;;; they obtained from the reservoir, confirming the resulting balances in the
;;; tap.
;;; Returns:
;;; -`(ok pipe-key)` on success
;;; - `ERR_BORROW_FEE_PAYMENT_FAILED` if the fee payment failed
;;; - Errors passed through from the StackFlow `deposit` function
(define-public (borrow-liquidity
    (stackflow <stackflow-token>)
    (amount uint)
    (fee uint)
    (token (optional <sip-010>))
    (my-balance uint)
    (reservoir-balance uint)
    (my-signature (buff 65))
    (reservoir-signature (buff 65))
    (nonce uint)
  )
  (let (
      (borrower tx-sender)
      (expected-fee (get-borrow-fee amount))
    )
    (try! (check-valid stackflow token))
    (asserts! (>= fee expected-fee) ERR_INVALID_FEE)
    (unwrap!
      (match token
        t (contract-call? t transfer fee tx-sender RESERVOIR none)
        (stx-transfer? fee tx-sender RESERVOIR)
      )
      ERR_BORROW_FEE_PAYMENT_FAILED
    )
    (as-contract (contract-call? stackflow deposit amount token borrower reservoir-balance
      my-balance reservoir-signature my-signature nonce
    ))
  )
)

;; Set the borrow rate for the contract (in basis points).
;; Returns:
;; - `(ok true)` on success
;; - `ERR_UNAUTHORIZED` if the caller is not the operator
(define-public (set-borrow-rate (new-rate uint))
  (begin
    (asserts! (is-eq contract-caller OPERATOR) ERR_UNAUTHORIZED)
    (asserts! (var-get initialized) ERR_NOT_INITIALIZED)
    (ok (var-set borrow-rate new-rate))
  )
)

;; Calculate the fee for borrowing a given amount.
;; Returns the fee amount in the smallest unit of the token.
(define-read-only (get-borrow-fee (amount uint))
  (/ (* amount (var-get borrow-rate)) u10000)
)

;;; As a provider, add `amount` of STX or FT `token` to the reservoir for
;;; borrowing. Providers must add at least min-liquidity-amount.
;;; Returns:
;;; - `(ok true)` on success
;;; - `ERR_AMOUNT_TOO_LOW` if the amount is less than min-liquidity-amount
;;; - `ERR_LIQUIDITY_POOL_FULL` if the maximum number of providers is reached
;;; - `ERR_FUNDING_FAILED` if the funding failed
(define-public (add-liquidity
    (token (optional <sip-010>))
    (amount uint)
  )
  (begin
    (try! (check-valid-token token))
    (asserts! (>= amount (var-get min-liquidity-amount)) ERR_AMOUNT_TOO_LOW)
    (asserts! (< (len (var-get providers)) MAX_PROVIDERS) ERR_LIQUIDITY_POOL_FULL)
    (unwrap!
      (match token
        t (contract-call? t transfer amount tx-sender (as-contract tx-sender) none)
        (stx-transfer? amount tx-sender (as-contract tx-sender))
      )
      ERR_FUNDING_FAILED
    )

    ;; Credit this provider with the amount of liquidity they added.
    (match (map-get? liquidity tx-sender)
      ;; If the provider already exists, update their liquidity.
      current
      (map-set liquidity tx-sender (+ current amount))
      ;; If the provider does not exist, add them to the list of providers.
      (begin
        (map-set liquidity tx-sender amount)
        (var-set providers
          (unwrap! (as-max-len? (append (var-get providers) tx-sender) u256)
            ERR_LIQUIDITY_POOL_FULL
          ))
      )
    )
    (ok true)
  )
)

;;; As a liquidity provider, remove `amount` of STX or FT `token` from the
;;; reservoir. If this would leave the provider with less than
;;; `min-liquidity-amount`, then the full amount will be removed.
;;; Returns:
;;; - `(ok uint)` on success, where `uint` is the amount removed
;;; - `ERR_UNAUTHORIZED` if the caller is not a liquidity provider
;;; - `ERR_TRANSFER_FAILED` if the transfer failed
(define-public (remove-liquidity-from-reservoir
    (token (optional <sip-010>))
    (amount uint)
  )
  (let (
      (provider tx-sender)
      (provider-liquidity (default-to u0 (map-get? liquidity provider)))
      (adjusted-amount (if (and (<= amount provider-liquidity)
                                (< (- provider-liquidity amount) (var-get min-liquidity-amount)))
                          provider-liquidity
                          amount
      ))
    )
    (try! (check-valid-token token))
    ;; Ensure the provider has enough liquidity.
    (asserts! (<= amount provider-liquidity) ERR_UNAUTHORIZED)

    ;; Update provider's liquidity
    (let (
        (new-liquidity (- provider-liquidity adjusted-amount))
      )
      (if (is-eq new-liquidity u0)
        ;; If provider is removing all liquidity, remove them from the list
        (begin
          (map-delete liquidity provider)
          (var-set providers (filter remove-provider (var-get providers)))
        )
        ;; Otherwise, just update their balance
        (map-set liquidity provider new-liquidity)
      )
    )

    ;; Transfer the funds
    (unwrap!
      (as-contract (match token
        t (contract-call? t transfer adjusted-amount tx-sender provider none)
        (stx-transfer? adjusted-amount tx-sender provider)
      ))
      ERR_TRANSFER_FAILED
    )
    (ok adjusted-amount)
  )
)

;; Filter function to remove a provider from the list
(define-private (remove-provider (p principal))
  (not (is-eq p tx-sender))
)

;; Set the minimum liquidity amount
(define-public (set-min-liquidity-amount (amount uint))
  (begin
    (asserts! (is-eq contract-caller OPERATOR) ERR_UNAUTHORIZED)
    (asserts! (var-get initialized) ERR_NOT_INITIALIZED)
    (ok (var-set min-liquidity-amount amount))
  )
)

;; Get the total liquidity in the reservoir
(define-read-only (get-total-liquidity)
  (fold + (map get-provider-liquidity (var-get providers)) u0)
)

;; Get the liquidity for a provider
(define-private (get-provider-liquidity (provider principal))
  (default-to u0 (map-get? liquidity provider))
)

;;; Given an optional trait, return an optional principal for the trait.
(define-private (contract-of-optional (trait (optional <sip-010>)))
  (match trait
    t (some (contract-of t))
    none
  )
)

;;; Check if the Reservoir is initialized and the correct stackflow and token
;;; contracts are passed.
(define-private (check-valid
    (stackflow <stackflow-token>)
    (token (optional <sip-010>))
  )
  (begin
    (asserts! (var-get initialized) ERR_NOT_INITIALIZED)
    (asserts! (is-eq (some (contract-of stackflow)) (var-get stackflow-contract))
      ERR_INCORRECT_STACKFLOW
    )
    (asserts! (is-eq (contract-of-optional token) (var-get supported-token))
      ERR_UNAPPROVED_TOKEN
    )
    (ok true)
  )
)

;;; Check if the Reservoir is initialized and the correct token is passed.
(define-private (check-valid-token (token (optional <sip-010>)))
  (begin
    (asserts! (var-get initialized) ERR_NOT_INITIALIZED)
    (asserts! (is-eq (contract-of-optional token) (var-get supported-token))
      ERR_UNAPPROVED_TOKEN
    )
    (ok true)
  )
)
