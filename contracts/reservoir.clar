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
(define-constant RESERVOIR current-contract)

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
(define-constant ERR_AMOUNT_NOT_AVAILABLE (err u209))

;;; Has this contract been initialized?
(define-data-var initialized bool false)

;;; Current borrow rate in basis points (1 = 0.01%)
;;; For example, 1000 = 10%
(define-data-var borrow-rate uint u0)

;;; Term length for borrowed liquidity in blocks (roughly 4 weeks).
(define-constant BORROW_TERM_BLOCKS u4000)

;;; The token supported by this instance of the Reservoir contract.
;;; If `none`, only STX is supported.
(define-data-var supported-token (optional principal) none)

;;; The StackFlow contract that this Reservoir is registered with.
(define-data-var stackflow-contract (optional principal) none)

;;; Map tracking the borrowed liquidity for each tap holder.
(define-map borrowed-liquidity
  principal
  {
    ;;; Amount borrowed
    amount: uint,
    ;;; Burn block height when the borrow expires
    until: uint,
  }
)

;; ----- Functions called by the Reservoir operator -----

;;; Initialize the Reservoir contract with the specified StackFlow contract,
;;; supported token, and initial borrow rate.
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
    (try! (as-contract? () (try! (contract-call? stackflow register-agent OPERATOR))))

    ;; Set the initial borrow rate.
    (var-set borrow-rate initial-borrow-rate)

    ;; Initialize the contract.
    (ok (var-set initialized true))
  )
)

;;; Set the borrow rate for the contract (in basis points).
;;; Returns:
;;; - `(ok true)` on success
;;; - `ERR_UNAUTHORIZED` if the caller is not the operator
(define-public (set-borrow-rate (new-rate uint))
  (begin
    (asserts! (is-eq contract-caller OPERATOR) ERR_UNAUTHORIZED)
    (asserts! (var-get initialized) ERR_NOT_INITIALIZED)
    (ok (var-set borrow-rate new-rate))
  )
)

;;; As the operator, add `amount` of STX or FT `token` to the reservoir for
;;; borrowing. Providers must add at least the minimum liquidity amount.
;;; Returns:
;;; - `(ok true)` on success
;;; - `ERR_FUNDING_FAILED` if the funding failed
(define-public (add-liquidity
    (token (optional <sip-010>))
    (amount uint)
  )
  (begin
    (asserts! (is-eq contract-caller OPERATOR) ERR_UNAUTHORIZED)
    (try! (check-valid-token token))
    (unwrap! (transfer-to-contract token amount) ERR_FUNDING_FAILED)
    (ok true)
  )
)

;;; As the operator, withdraw `amount` of STX or FT `token` from the Reservoir
;;; to `recipient`.
;;; Returns:
;;; - `(ok uint)` on success, where `uint` is the amount removed
;;; - `ERR_UNAUTHORIZED` if the caller is not a liquidity provider
;;; - `ERR_NOT_INITIALIZED` if the contract has not been initialized
;;; - `ERR_UNAPPROVED_TOKEN` if the token is not the correct token
;;; - `ERR_AMOUNT_NOT_AVAILABLE` if the amount is greater than the available liquidity
;;; - `ERR_TRANSFER_FAILED` if the transfer failed
(define-public (withdraw-liquidity
    (token (optional <sip-010>))
    (amount uint)
    (recipient principal)
  )
  (begin
    (asserts! (is-eq contract-caller OPERATOR) ERR_UNAUTHORIZED)
    (try! (check-valid-token token))
    (asserts! (<= amount (unwrap-panic (get-available-liquidity token)))
      ERR_AMOUNT_NOT_AVAILABLE
    )

    ;; Perform the withdrawal.
    (unwrap! (transfer-from-contract token amount recipient) ERR_TRANSFER_FAILED)

    (ok amount)
  )
)

;;; Force-cancel a tap with the specified user. This will close the pipe and
;;; return the last balances to the user and the reservoir. This should only
;;; be called by the operator of the reservoir when the tap holder has failed
;;; to provide the needed signatures for a withdrawal.
(define-public (force-cancel-tap
    (stackflow <stackflow-token>)
    (token (optional <sip-010>))
    (user principal)
  )
  (let (
      (borrow (default-to {
        amount: u0,
        until: u0,
      }
        (map-get? borrowed-liquidity user)
      ))
      (borrowed-amount (if (> burn-block-height (get until borrow))
        u0
        (get amount borrow)
      ))
    )
    (asserts! (is-eq contract-caller OPERATOR) ERR_UNAUTHORIZED)
    (try! (check-valid stackflow token))

    ;; The reservoir cannot attempt to force-cancel a tap that has borrowed liquidity.
    (asserts! (is-eq borrowed-amount u0) ERR_UNAUTHORIZED)

    ;; Call the StackFlow contract to force-cancel the tap.
    (as-contract? () (try! (contract-call? stackflow force-cancel token user)))
  )
)

;;; Force-close a tap with the specified user. This will close the pipe and
;;; return the signed balances to the user and the reservoir. This should only
;;; be called by the operator of the reservoir when the tap holder has failed
;;; to provide the needed signatures for a withdrawal.
(define-public (force-close-tap
    (stackflow <stackflow-token>)
    (token (optional <sip-010>))
    (user principal)
    (user-balance uint)
    (reservoir-balance uint)
    (user-signature (buff 65))
    (reservoir-signature (buff 65))
    (nonce uint)
    (action uint)
    (actor principal)
    (secret (optional (buff 32)))
    (valid-after (optional uint))
  )
  (let (
      (borrow (default-to {
        amount: u0,
        until: u0,
      }
        (map-get? borrowed-liquidity user)
      ))
      (borrowed-amount (if (> burn-block-height (get until borrow))
        u0
        (get amount borrow)
      ))
    )
    (asserts! (is-eq contract-caller OPERATOR) ERR_UNAUTHORIZED)
    (try! (check-valid stackflow token))

    ;; The reservoir cannot attempt to force-close a tap that has borrowed liquidity.
    (asserts! (is-eq borrowed-amount u0) ERR_UNAUTHORIZED)

    ;; Call the StackFlow contract to force-close the tap.
    (as-contract? ()
      (try! (contract-call? stackflow force-close token user reservoir-balance
        user-balance reservoir-signature user-signature nonce action actor
        secret valid-after
      ))
    )
  )
)

;;; Return liquidity to the reservoir via a withdrawal as the reservoir. The
;;; reservoir operator will request signatures from the tap holder when the
;;; reservoir's balance has reached a certain threshold. If the user fails to
;;; provide the needed signatures for this withdrawal, then the reservoir will
;;; refuse further transfers to/from the tap holder and eventually force-close
;;; the tap.
;;; Returns:
;;; - `(ok true)` on success
;;; - `ERR_NOT_INITIALIZED` if the contract has not been initialized
;;; - `ERR_INCORRECT_STACKFLOW` if the StackFlow contract is not the correct one
;;; - `ERR_UNAPPROVED_TOKEN` if the token is not the correct token
(define-public (return-liquidity-to-reservoir
    (stackflow <stackflow-token>)
    (token (optional <sip-010>))
    (user principal)
    (amount uint)
    (user-balance uint)
    (reservoir-balance uint)
    (user-signature (buff 65))
    (reservoir-signature (buff 65))
    (nonce uint)
  )
  (let (
      (borrow (default-to {
        amount: u0,
        until: u0,
      }
        (map-get? borrowed-liquidity user)
      ))
      (borrowed-amount (if (> burn-block-height (get until borrow))
        u0
        (get amount borrow)
      ))
    )
    (asserts! (is-eq contract-caller OPERATOR) ERR_UNAUTHORIZED)
    (try! (check-valid stackflow token))
    ;; The reservoir cannot attempt to return liquidity that is still borrowed.
    (asserts! (>= reservoir-balance borrowed-amount) ERR_UNAUTHORIZED)

    (print {
      topic: "return-liquidity-to-reservoir",
      amount: amount,
    })
    (try! (match token
      t (as-contract? ()
        (try! (contract-call? stackflow withdraw amount token user reservoir-balance
          user-balance reservoir-signature user-signature nonce
        ))
      )
      (as-contract? ()
        (try! (contract-call? stackflow withdraw amount token user reservoir-balance
          user-balance reservoir-signature user-signature nonce
        ))
      )
    ))

    (ok true)
  )
)

;; ----- Functions called by Tap holders -----

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
    (contract-call? stackflow deposit amount token RESERVOIR my-balance
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
;;; -`(ok expire-block)` on success
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
      (until (+ burn-block-height BORROW_TERM_BLOCKS))
    )
    (try! (check-valid stackflow token))
    (asserts! (>= fee expected-fee) ERR_INVALID_FEE)
    (unwrap! (transfer-to-contract token fee) ERR_BORROW_FEE_PAYMENT_FAILED)
    (try! (match token
      t (as-contract? ((with-ft (contract-of t) "*" amount))
        (try! (contract-call? stackflow deposit amount token borrower reservoir-balance
          my-balance reservoir-signature my-signature nonce
        ))
      )
      (as-contract? ((with-stx amount))
        (try! (contract-call? stackflow deposit amount token borrower reservoir-balance
          my-balance reservoir-signature my-signature nonce
        ))
      )
    ))

    ;; Record the borrowed liquidity for the borrower.
    (map-set borrowed-liquidity borrower {
      amount: amount,
      until: until,
    })

    (ok until)
  )
)

;; ----- Read-only functions -----

;;; Calculate the fee for borrowing a given amount.
;;; Returns the fee amount in the smallest unit of the token.
(define-read-only (get-borrow-fee (amount uint))
  (/ (* amount (var-get borrow-rate)) u10000)
)

;;; Get the available liquidity in the reservoir for `token`.
;;; NB: This cannot be a read-only function because of the contract-call? in
;;; the FT case. Instead, it must be a public function that returns a response
;;; but it is written such that it only returns `ok` values. Users should use
;;; `unwrap-panic` on its result.
(define-public (get-available-liquidity (token (optional <sip-010>)))
  (ok (match token
    t (match (contract-call? t get-balance current-contract)
      balance balance
      e u0
    )
    (stx-get-balance current-contract)
  ))
)

;; ---- Private helper functions -----

;;; Transfer `amount` of `token` from this contract to `recipient`.
(define-private (transfer-from-contract
    (token (optional <sip-010>))
    (amount uint)
    (recipient principal)
  )
  (match token
    t (as-contract? ((with-ft (contract-of t) "*" amount))
      (try! (contract-call? t transfer amount tx-sender recipient none))
    )
    (as-contract? ((with-stx amount))
      (try! (stx-transfer? amount tx-sender recipient))
    )
  )
)

;;; Transfer 'amount' of 'token' from `tx-sender` to this contract.
(define-private (transfer-to-contract
    (token (optional <sip-010>))
    (amount uint)
  )
  (match token
    t (contract-call? t transfer amount tx-sender current-contract none)
    (stx-transfer? amount tx-sender current-contract)
  )
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
