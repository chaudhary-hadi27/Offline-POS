# Admin manual (no dashboard): how you run customers by hand

Everything below runs on **your** PC, in the project folder, with `license-keys/` present. The tools ask for the key passphrase.
Your record file is `license-keys/issued-licenses.csv`. `npm run license:list` turns it into a customer table.

## Words
- **Tier**: Pro (every page but WhatsApp Deals) or Premium (everything). Free is just "no active licence": only Settings.
- **Plan**: how long. `M30` trial 30 days, `Y01` 1 year, `Y03`, `Y10`, `CUSTOM --expires 2027-03-31`.
- **Wallet**: a PC can hold one Pro and one Premium. One runs, the other is paused (its days are kept).

## 1. New customer
1. Customer installs, opens Settings > License, sends you the **Hardware ID**.
2. `npm run license:issue -- --machine <ID> --customer "Name" --plan Y01 --tier pro`   (or `--tier premium`)
3. Send the `POS1....` text on WhatsApp. They paste it in Settings > License. Done.
Trial: `--plan M30`. One trial per Hardware ID by habit: check `npm run license:list -- --customer <name>` first.

## 2. Renewal (same tier)
`npm run license:issue -- --machine <ID> --customer "Name" --plan Y01 --tier pro --renew`
`--renew` counts from the END of that tier's current key (or from today if it already ended), so no days are lost.
If the customer had paused that license, the app adds the paused days by itself.

## 3. Upgrade Pro to Premium (the customer keeps their Pro days)
Issue a Premium key:  `... --plan Y01 --tier premium`   (or a short one like `M30` if they only want WhatsApp for a month)
- When they paste it, **Premium starts at once and Pro is paused**; the Pro days are kept.
- On the License tab they can press **Use this** to go back to Pro whenever they like. Premium then pauses.
- When Premium ends, Pro starts by itself with the days it had.
So you never need to calculate days. Charge for the Premium period you issue.

## 4. Downgrade, refund, or "replace everything"
Add `--exclusive`:  `... --plan Y01 --tier pro --exclusive`
The key removes the customer's other licenses, and older keys of the other tier can never be entered again.
To give Premium back later, issue a NEW Premium key (it is newer, so it works).

## 5. Customers who already have an old "all features" licence
- Their old key has no tier. The app runs it as **Premium** (nothing is taken away). `npm run license:list` shows them with a `*`.
- Nothing to do until they renew. At renewal, decide what to sell them and issue a tiered key. A key of the same tier replaces the old one; a Pro key next to an old key is only saved (the old Premium keeps running) unless you add `--exclusive`.
- If you decide old keys should become Pro, change `LEGACY_TIER` in `electron/license/tiers.js` before the next release (they would lose WhatsApp at once on update), and warn them first.

## 6. Customer reinstalled Windows or changed the PC
The Hardware ID changes, so the old key says "different PC". Ask for the new ID, issue a new key (same tier, plan and end date: use `CUSTOM --expires <their old end date>`). Write the reason in your notes. Do not give a new trial.

## 7. "My PC date is wrong / locked out because of the date"
Customer sets the correct PC date and sends the Hardware ID. `npm run license:issue -- --repair --machine <ID>` gives a `POS1R....` code. They paste it in the same License box. It works for that PC only and once.

## 8. Forgot PIN
1. Customer: lock screen > Forgot PIN > Developer recovery > sends you the code shown (like `A1B2-C3D4`).
2. You: `npm run recovery:issue -- --challenge A1B2-C3D4`   then send the `PR1....` code. It works for that PC, that day.
3. They paste it. The old lock is cleared and they set a new one. (Check who is asking before you do this.)

## 9. WhatsApp campaign stopped (app closed / power cut)
Nothing for you to do. At the next start a bar says the campaign is paused. In WhatsApp Deals they press **Resume sending**.
If the app closed in the middle of one message, that customer shows "not sure": the owner picks **Send again** or **Skip**.

## 10. Keeping your own records (do this every week)
- `npm run license:list -- --expiring 30`   who ends in the next 30 days: send them a reminder.
- Copy `license-keys/` to the USB/second place after every new key.
- In a notebook or sheet keep: customer phone, city, what they paid, tier, and why any exception was made.

## Messages you can copy
- Key: "Assalam o Alaikum. Ye aap ki license key hai. Settings > License mein paste karein aur Activate dabayen."
- Upgrade: "Premium start ho gaya hai. Aap ke Pro ke din save hain. Settings > License mein 'Use this' se kabhi bhi Pro par wapas ja sakte hain."
- Reminder: "Aap ki license {N} din mein khatam ho rahi hai. Renew ke liye bata dein."
