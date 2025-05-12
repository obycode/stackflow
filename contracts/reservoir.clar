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

;;; Has this contract been initialized?
(define-data-var initialized bool false)

;; Current borrow rate in basis points (1 = 0.01%)
;; For example, 1000 = 10%
(define-data-var borrow-rate uint u0)

;;; The token supported by this instance of the Reservoir contract.
;;; If `none`, only STX is supported.
(define-data-var supported-token (optional principal) none)

;;; Track the open taps
;; The key is the principal and the value is the height at which it was opened.
(define-map taps principal uint)

(define-public (init
    (token (optional <sip-010>))
    (stackflow <stackflow-token>)
    (initial-borrow-rate uint)
  )
  (begin
    (asserts! (is-eq contract-caller OPERATOR) ERR_UNAUTHORIZED)
    (asserts! (not (var-get initialized)) ERR_ALREADY_INITIALIZED)

    ;; Set the token for this instance of the Reservoir contract.
    (var-set supported-token (contract-of-optional token))

    ;; Authorize the operator as a StackFlow agent for this contract.
    (try! (as-contract (contract-call? stackflow register-agent OPERATOR)))

    ;; Set the initial borrow rate.
    (var-set borrow-rate initial-borrow-rate)

    ;; Initialize the contract.
    (ok (var-set initialized true))
  )
)

;;; Deposit `amount` funds into an unfunded tap for FT `token` (`none`
;;; indicates STX). Create the tap if one does not already exist.
;;; Returns:
;;; - The pipe key on success
;;;   ```
;;;   { token: (optional principal), principal-1: principal, principal-2: principal }
;;;   ```
;;; - `ERR_NOT_INITIALIZED` if the contract has not been initialized
;;; - `ERR_UNAPPROVED_TOKEN` if the token is not the correct token
;;; - `ERR_NONCE_TOO_LOW` if the nonce is less than the pipe's saved nonce
;;; - `ERR_CLOSE_IN_PROGRESS` if a forced closure is in progress
;;; - `ERR_ALREADY_FUNDED` if the pipe has already been funded
(define-public (fund-tap
    (token (optional <sip-010>))
    (amount uint)
    (nonce uint)
  )
  (begin
    (asserts! (var-get initialized) ERR_NOT_INITIALIZED)
    (contract-call? .stackflow fund-pipe token amount RESERVOIR nonce)
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
    (asserts! (var-get initialized) ERR_NOT_INITIALIZED)
    (asserts! (>= fee expected-fee) ERR_INVALID_FEE)
    (unwrap!
      (match token
        t (contract-call? t transfer fee tx-sender RESERVOIR none)
        (stx-transfer? fee tx-sender RESERVOIR)
      )
      ERR_BORROW_FEE_PAYMENT_FAILED
    )
    (as-contract (contract-call? .stackflow deposit amount token borrower reservoir-balance
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

;;; As the operator, add `amount` of STX or FT `token` to the reservoir for
;;; borrowing.
;;; Returns:
;;; - `(ok true)` on success
;;; - `ERR_UNAUTHORIZED` if the caller is not the operator
;;; - `ERR_FUNDING_FAILED` if the funding failed
(define-public (add-liquidity
    (token (optional <sip-010>))
    (amount uint)
  )
  (begin
    (asserts! (is-eq contract-caller OPERATOR) ERR_UNAUTHORIZED)
    (asserts! (var-get initialized) ERR_NOT_INITIALIZED)
    (unwrap!
      (match token
        t (contract-call? t transfer amount tx-sender (as-contract tx-sender) none)
        (stx-transfer? amount tx-sender (as-contract tx-sender))
      )
      ERR_FUNDING_FAILED
    )
    (ok true)
  )
)

;;; As the operator, remove `amount` of STX or FT `token` from the reservoir.
;;; Returns:
;;; - `(ok true)` on success
;;; - `ERR_UNAUTHORIZED` if the caller is not the operator
;;; - `ERR_TRANSFER_FAILED` if the transfer failed
(define-public (remove-liquidity
    (token (optional <sip-010>))
    (amount uint)
  )
  (begin
    (asserts! (is-eq contract-caller OPERATOR) ERR_UNAUTHORIZED)
    (asserts! (var-get initialized) ERR_NOT_INITIALIZED)
    (unwrap!
      (as-contract (match token
        t (contract-call? t transfer amount tx-sender OPERATOR none)
        (stx-transfer? amount tx-sender OPERATOR)
      ))
      ERR_TRANSFER_FAILED
    )
    (ok true)
  )
)

;;; Given an optional trait, return an optional principal for the trait.
(define-private (contract-of-optional (trait (optional <sip-010>)))
  (match trait
    t (some (contract-of t))
    none
  )
)
