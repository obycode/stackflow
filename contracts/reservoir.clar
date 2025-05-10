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
;; (impl-trait 'SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-token-0-6-0.stackflow-token)

(define-constant OPERATOR tx-sender)
(define-constant RESERVOIR (as-contract tx-sender))

;; Error code
(define-constant ERR_BORROW_FEE_PAYMENT_FAILED (err u200))
(define-constant ERR_UNAUTHORIZED (err u201))
(define-constant ERR_FUNDING_FAILED (err u202))
(define-constant ERR_TRANSFER_FAILED (err u203))

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
    (with principal)
    (nonce uint)
  )
  (contract-call? .stackflow fund-pipe token amount RESERVOIR nonce)
)

;;; Borrow `amount` from the reservoir to add receiving capacity to the
;;; caller's tap. The caller pays a fee of `fee` to the reservoir. The caller
;;; provides their own signature as well as a signature that they obtained
;;; from the reservoir, confirming the resulting balances in the tap.
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
  (let ((borrower tx-sender))
    (unwrap!
      (match token
        t (contract-call? t transfer amount tx-sender (as-contract tx-sender) none)
        (stx-transfer? amount tx-sender (as-contract tx-sender))
      )
      ERR_BORROW_FEE_PAYMENT_FAILED
    )
    (as-contract (contract-call? .stackflow deposit amount token borrower reservoir-balance
      my-balance reservoir-signature my-signature nonce
    ))
  )
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
    (asserts! (is-eq tx-sender OPERATOR) ERR_UNAUTHORIZED)
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
    (asserts! (is-eq tx-sender OPERATOR) ERR_UNAUTHORIZED)
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
