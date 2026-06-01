# Member-Member Handicap Review — Geneva Golf Club

A single-file web app for running a **fair** member-member golf tournament. It gives the
committee one place to:

- See every player's **handicap index, course handicap (9 & 18), rounds posted, average /
  recent / best differential**, and a scoring **trend**.
- **Screen for anomalies** in posting and scoring behavior (sandbagging, index inflation,
  trending-hot players, stale or thin posting histories) — each flag comes with a
  plain-English reason.
- **Build 2-person teams** and instantly see the **playing handicaps for all four rounds**
  using your tournament's allocation rules, with an auto-balance helper.

Everything runs in the browser. Data is stored locally (`localStorage`) — nothing is sent
anywhere. Export a JSON backup to save or share.

---

## Quick start

1. Open **`index.html`** in any modern browser (double-click it, or host it — see below).
2. Click **Load sample data** to explore with 8 example members, *or*
3. Click **Import…** to load your own members, or **+ Add player** to type them in.
4. Visit the tabs: **Players → Anomaly Review → Team Builder → Course & Rules**.

> ⚠️ **Verify the course ratings.** Open **Course & Rules** and confirm the Geneva Golf Club
> White/Blue tee ratings, slopes, and pars (18- and 9-hole) against the official scorecard.
> The pre-filled numbers are best-known estimates, and **every handicap figure depends on them.**

---

## Getting data in

### Players
- **CSV** with columns `lastName,firstName,ghin,index,gender` (see `sample-players.csv`).
- Or a **GHIN golfer-search JSON** response.

### Pull the whole Geneva roster live from GHIN (recommended)
The app talks to GHIN's `api2.ghin.com` mobile API **directly from the browser** — GHIN
currently serves permissive CORS headers, so no proxy is needed. The app token and Geneva club
id (`52147`) are preconfigured. On the **⛳ Pull from GHIN** tab:

1. Enter **your own** GHIN email/number + password → **Log in to GHIN**.
2. Click **⤓ Pull everyone (roster + scores)** — loads every active Geneva member (name, GHIN #,
   index) and fetches each one's score history in a single step. (Or use the step-by-step buttons,
   with an optional last-name filter.)

Your password is never stored; only a short-lived session token is kept for the current tab.
Plus-handicaps (`"+2.7"` → −2.7) and 9-hole scaled differentials are handled automatically.

> Use your own GHIN credentials and only pull data your committee is entitled to review. GHIN's
> endpoints are unofficial and can change.

### Alternatives
- **Paste JSON** for one member into **Import… → box 2** if you captured a scores response by hand.
- **Command line** — [`ghin-proxy.js`](./ghin-proxy.js) (Node 18+) for scripting/batch:
  ```bash
  # Geneva roster (club_id 52147)
  node ghin-proxy.js --email you@example.com --password 'secret' --apptoken 'TOKEN' --club 52147 > roster.json
  # one golfer's scores
  node ghin-proxy.js --email you@example.com --password 'secret' --apptoken 'TOKEN' --ghin 1234567 > player.json
  ```
- **CSV** — players (`lastName,firstName,ghin,index,gender`) and rounds
  (`…,date,score,rating,slope,tees,holes,type`). See `sample-players.csv` / `sample-rounds.csv`.

---

## How handicaps are calculated

- **Score differential** = `(Adjusted Gross − Course Rating) × 113 / Slope`. 9-hole rounds are
  approximated to an 18-hole equivalent for review.
- **Handicap Index** uses the WHS "average of the lowest differentials" table. The app uses the
  index you import when present, and also shows a **computed** index from posted rounds (a
  mismatch is itself a flag).
- **Course Handicap (18)** = `Index × (Slope ÷ 113) + (Rating − Par)`.
- **Course Handicap (9)** = `(Index ÷ 2) × (Slope9 ÷ 113) + (Rating9 − Par9)`.

## Tournament rounds & allocations (editable in **Course & Rules**)

| Round | Format | Tees | Handicap allocation |
|------:|--------|------|---------------------|
| 1 | Scramble | White | **35%** of low player's CH + **15%** of high player's CH, **× 50%** (one team number) |
| 2 | Modified Alternate Shot | Blue | **50%** of the team's combined 9-hole handicap |
| 3 | Partner's Best Ball | White | **90%** of each player's 9-hole handicap |
| 4 | Total Score of Partners | Blue | **100%** (full) of each player's 9-hole handicap |

Change any percentage, tee, rating, or threshold in the **Course & Rules** tab.

---

## Anomaly flags (screening signals, not proof)

| Flag | Meaning |
|------|---------|
| **Trending hot** | Last-5 differentials much better than the index — playing above their number. |
| **Scores rising** | Recent differentials drifting higher than older ones — possible index inflation before the event. |
| **Inconsistent** | High spread between good and bad rounds; net results swing widely. |
| **Big upside** | Best round well below index — capable of a very low net. |
| **Few rounds / Index mismatch** | Too little data for a stable index, or stored index ≠ what posted rounds imply. |
| **Stale posting / Mostly 9-hole / Single course** | Posting habits that make the index less reliable. |

Always open the player's round history before drawing conclusions. Thresholds are adjustable.

---

## Hosting (optional)

It's a static file — host it free on **GitHub Pages**: push this repo, then enable Pages
(Settings → Pages → deploy from branch). The app will be available at
`https://<user>.github.io/<repo>/`. No build step.

## Privacy

All data lives in your browser only. Clearing browser storage erases it — keep a JSON backup
(**Export backup**). The optional GHIN proxy runs on your own machine with your own credentials.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The entire app (HTML + CSS + JS, no dependencies). |
| `ghin-proxy.js` | Optional Node helper to fetch GHIN scores as JSON. |
| `sample-players.csv` / `sample-rounds.csv` | Example import files. |
