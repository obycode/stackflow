
;; title: stackflow
;; version: 0.1.0
;; summary: Stackflow is a payment channel network built on Stacks that enables
;;   off-chain, non-custodial, high-speed payments between users and is
;;   designed to be simple, secure, and efficient. It supports payments in STX
;;   or approved SIP-010 fungible tokens.


(use-trait sip-010 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

(define-constant contract-deployer tx-sender)

;; Constants for SIP-018 structured data
(define-constant structured-data-prefix 0x534950303138)
(define-constant message-domain-hash (sha256 (unwrap-panic (to-consensus-buff?
	{
		name: "StackFlow",
		version: "0.1.0",
		chain-id: chain-id
	}
))))
(define-constant structured-data-header (concat structured-data-prefix message-domain-hash))

;; Error codes
(define-constant err-deposit-failed (err u100))
(define-constant err-no-such-channel (err u101))
(define-constant err-invalid-principal (err u102))
(define-constant err-invalid-sender-signature (err u103))
(define-constant err-invalid-other-signature (err u104))
(define-constant err-consensus-buff (err u105))
(define-constant err-unauthorized (err u106))
(define-constant err-max-allowed (err u107))
(define-constant err-invalid-total-balance (err u108))
(define-constant err-withdrawal-failed (err u109))

;;; List of allowed SIP-010 tokens as set by the owner of the contract.
;;; This is required since SIP-010 tokens are not guaranteed not to have side-
;;; effects other than those defined in the SIP-010 standard. For example, an
;;; untrusted token could transfer funds from the contract when called within
;;; an `as-contract` expression.
(define-data-var allowed-sip-010s (list 256 principal) (list))

;;; Map tracking the initial balances in channels between two principals for a
;;; given token.
(define-map
  channels
  { token: (optional principal), principal-1: principal, principal-2: principal }
  { balance-1: uint, balance-2: uint }
)

;; Public Functions
;;

;;; Deposit `deposit` funds into a channel between `tx-sender` and `with` for
;;; FT `token` (`none` indicates STX). Create the channel if one does not
;;; already exist.
;;; Returns the channel key on success.
(define-public (fund-channel (token (optional <sip-010>)) (deposit uint) (with principal))
  (let
    (
      (channel-key (try! (get-channel-key (contract-of-optional token) tx-sender with)))
      (existing-channel (map-get? channels channel-key))
      (token-principal (match token t (some (contract-of t)) none))
      (channel
        (match
          existing-channel
          ch
          ch
          { balance-1: u0, balance-2: u0 }
        )
      )
      (updated-channel (try! (increase-sender-balance channel-key channel token deposit)))
    )
    (map-set channels channel-key updated-channel)
    (print {
      event: "channel-funded",
      channel-key: channel-key,
      sender: tx-sender,
      amount: deposit,
    })
    (ok channel-key)
  )
)

(define-public (close-channel
    (token (optional <sip-010>))
    (with principal)
    (my-balance uint)
    (their-balance uint)
    (my-signature (buff 65))
    (their-signature (buff 65))
    (nonce uint)
  )
  (let
    (
      (channel-key (try! (get-channel-key (contract-of-optional token) tx-sender with)))
      (balances (unwrap! (map-get? channels channel-key) err-no-such-channel))
      (data (make-channel-data channel-key my-balance their-balance nonce))
      (data-hash (sha256 (unwrap! (to-consensus-buff? data) err-consensus-buff)))
      (input (sha256 (concat structured-data-header data-hash)))
      (sender tx-sender)
    )
    ;; If the total balance of the channel is not equal to the sum of the
    ;; balances provided, the channel close is invalid.
    (asserts!
      (is-eq
        (+ my-balance their-balance)
        (+ (get balance-1 balances) (get balance-2 balances))
      )
      err-invalid-total-balance
    )

    ;; Verify the signatures of the two parties.
    (asserts! (verify-signature input my-signature tx-sender) err-invalid-sender-signature)
    (asserts! (verify-signature input their-signature with) err-invalid-other-signature)

    ;; Remove the channel from the map.
    (map-delete channels channel-key)

    ;; Pay out the balances.
    (match token
      t
      (begin
        (unwrap! (as-contract (contract-call? t transfer my-balance tx-sender sender none)) err-withdrawal-failed)
        (unwrap! (as-contract (contract-call? t transfer their-balance tx-sender with none)) err-withdrawal-failed)
      )
      (begin
        (unwrap! (as-contract (stx-transfer? my-balance tx-sender sender)) err-withdrawal-failed)
        (unwrap! (as-contract (stx-transfer? their-balance tx-sender with)) err-withdrawal-failed)
      )
    )
    (ok true)
  )
)

;;; As the owner of this contract, add a SIP-010 token to the list of allowed
;;; tokens.
(define-public (add-allowed-sip-010 (token principal))
  (let (
      (current (var-get allowed-sip-010s))
      (updated (unwrap! (as-max-len? (append current token) u256) err-max-allowed))
    )
    (asserts! (is-eq contract-caller contract-deployer) err-unauthorized)
    (ok (var-set allowed-sip-010s updated))
  )
)

;;; As the owner of this contract, remove a SIP-010 token from the list of
;;; allowed tokens.
(define-public (remove-allowed-sip-010 (token principal))
  (let (
      (current (var-get allowed-sip-010s))
      (updated (remove-principal-from-list current token))
    )
    (asserts! (is-eq contract-caller contract-deployer) err-unauthorized)
    (ok (var-set allowed-sip-010s updated))
  )
)

;; Read Only Functions
;;

;;; Get the current balances of the channel between `tx-sender` and `with` for
;;; token `token` (`none` indicates STX).
(define-read-only (get-channel-balances (token (optional principal)) (with principal))
  (let
    (
      (channel-key (try! (get-channel-key token tx-sender with)))
      (balances (unwrap! (map-get? channels channel-key) err-no-such-channel))
    )
    (ok balances)
  )
)

(define-read-only (verify-signature (hash (buff 32)) (signature (buff 65)) (signer principal))
	(is-eq (principal-of? (unwrap! (secp256k1-recover? hash signature) false)) (ok signer))
)

(define-read-only (verify-signed-structured-data (structured-data-hash (buff 32)) (signature (buff 65)) (signer principal))
	(verify-signature (sha256 (concat structured-data-header structured-data-hash)) signature signer)
)

;; Private Functions
;;

;;; Given an optional trait, return an optional principal for the trait.
(define-private (contract-of-optional (trait (optional <sip-010>)))
  (match trait
    t
    (some (contract-of t))
    none
  )
)

;;; Given two principals, return the key for the channel between these two principals.
;;; The key is a map with two keys: principal-1 and principal-2, where principal-1 is the principal
;;; with the lower consensus representation.
(define-private (get-channel-key (token (optional principal)) (principal-1 principal) (principal-2 principal))
  (let
    (
      (p1 (unwrap! (to-consensus-buff? principal-1) err-invalid-principal))
      (p2 (unwrap! (to-consensus-buff? principal-2) err-invalid-principal))
    )
    (ok (if (< p1 p2)
      { token: token, principal-1: principal-1, principal-2: principal-2 }
      { token: token, principal-1: principal-2, principal-2: principal-1 }
    ))
  )
)

;;; Transfer `amount` from `tx-sender` to the contract and update the channel
;;; balances.
(define-private (increase-sender-balance
    (channel-key { token: (optional principal), principal-1: principal, principal-2: principal })
    (balances { balance-1: uint, balance-2: uint })
    (token (optional <sip-010>))
    (amount uint)
  )
  (begin
    (match token
      t
      (unwrap! (contract-call? t transfer amount tx-sender (as-contract tx-sender) none) err-deposit-failed)
      (unwrap! (stx-transfer? amount tx-sender (as-contract tx-sender)) err-deposit-failed)
    )
    (ok
      (if (is-eq tx-sender (get principal-1 channel-key))
        (merge balances { balance-1: (+ (get balance-1 balances) amount) })
        (merge balances { balance-2: (+ (get balance-2 balances) amount) })
      )
    )
  )
)

;;; Remove a principal from a list of principals.
;;; Note that this method seems strange, but it is more cost efficient than the
;;; alternatives (h/t unknown original creator of this technique).
(define-read-only (remove-principal-from-list (l (list 256 principal)) (to-remove principal))
  (map unwrap-panic_ (filter is-some_ (map cmp l 
    (list to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
          to-remove to-remove to-remove to-remove to-remove to-remove to-remove to-remove
    )
  )))
)
(define-private (unwrap-panic_ (x (optional principal))) (unwrap-panic x))
(define-private (cmp (x principal) (y principal)) (if (is-eq x y) none (some x)))
(define-private (is-some_ (i (optional principal))) (is-some i))

;;; Build up the structured data for a channel close operation.
;;; The structured data is a map with the following keys:
;;; - token: the token used in the channel
;;; - principal-1: the first principal in the channel
;;; - principal-2: the second principal in the channel
;;; - balance-1: the balance of the first principal in the channel
;;; - balance-2: the balance of the second principal in the channel
;;; - nonce: the nonce for this channel data
;;; This function assumes that the channel has already been validated to
;;; include these two principals.
(define-private (make-channel-data
    (channel-key { token: (optional principal), principal-1: principal, principal-2: principal })
    (my-balance uint)
    (their-balance uint)
    (nonce uint)
  )
  (let
    (
      (balances (if (is-eq tx-sender (get principal-1 channel-key))
        { balance-1: my-balance, balance-2: their-balance }
        { balance-1: their-balance, balance-2: my-balance }
      ))
    )
    (merge (merge channel-key balances) { nonce: nonce })
  )
)