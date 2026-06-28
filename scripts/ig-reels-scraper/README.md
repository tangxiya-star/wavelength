# IG Reels Scraper

Appends every reel of an account (link + view count, when shown on the grid
thumbnail) into **one combined CSV**. Run it for as many accounts as you like —
they all accumulate in the same file. Human-like jitter/lag throughout.

## Setup (once)

```bash
cd scripts/ig-reels-scraper
npm install
npx playwright install chromium
```

## Log in (once, or whenever the session expires)

```bash
node scrape.mjs --login
```

A browser window opens. Log into Instagram **manually** (handles 2FA/captcha).
The script auto-detects success and saves your session to
`ig-data/storageState.json` — no password is stored.

> Use a secondary/throwaway account. Automated access can get one rate-limited
> or flagged.

## Scrape

```bash
node scrape.mjs jess.studytips                    # one account (all reels)
node scrape.mjs jess.studytips studytee gohar     # several -> same CSV
node scrape.mjs --headless jess.studytips         # no visible window

# individual post / reel permalinks -> just that post's view count + owner
node scrape.mjs "https://www.instagram.com/p/DVw7O_9DNtY/"
node scrape.mjs jess.studytips "https://www.instagram.com/reel/DXH5ogwjANV/"   # mix accounts + posts
```

Accounts and post-links can be freely mixed in one run; duplicate links are
auto-deduped.

## Output

`ig-data/reels.csv` — one row per reel, appended across runs/accounts:

| column | meaning |
|---|---|
| `scraped_at` | ISO timestamp of the run |
| `username` | which account |
| `shortcode` | reel id |
| `url` | direct reel link |
| `views_text` | raw overlay value (`1.2M`) |
| `views` | parsed number (`1200000`), blank if not shown |

## Notes

- For **accounts**, view counts come straight off the reels grid thumbnails.
- For **single post links**, the grid number isn't available, so the script
  decodes the shortcode to its media id locally and reads `play_count` from
  Instagram's media-info API (exact count). Image posts/carousels have no
  play count and come back blank.
- Append-only: re-running an account adds fresh rows (distinguished by
  `scraped_at`), so you can also chart growth over time by pivoting on
  `shortcode`. De-dupe in your spreadsheet by taking the latest row per reel.
- Be gentle — don't loop it constantly. It scrolls with randomized delays to
  look human; hammering risks a temporary block.
