# Yahoo Auctions in English

Browse Yahoo! Auctions Japan in English with prices in your currency. Runs only on your computer.

## Download (Windows)

You need [Google Chrome](https://www.google.com/chrome/). Nothing else to install.

1. Download `yahoo-auctions-en-windows.zip` from the [latest release](https://github.com/kianz20/yahoo-auctions-en/releases/latest).
2. Right-click the zip and choose **Extract All**.
3. Open the new folder and double-click `start`.
4. If Windows says it protected your PC, click **More info**, then **Run anyway**.
5. In the page that opens, click **Turn on** in the banner, then again for the second language pack.

Keep the black window open while you browse. Closing it stops the app.

## Run from source

Double-click `start.bat`, or run `node server.js` and open <http://localhost:3210> in Chrome.
To use a different port, set the `PORT` environment variable.
Needs Node 18+ and no packages. The first time, click **Turn on** in the banner, then again for
the second language pack.

`start.bat` opens the app in its own Chrome profile, stored in `.chrome-profile/` here (around
100 MB once language packs are installed). It runs alongside your normal Chrome and doesn't touch it.
To reset it, close that window and delete the folder.

## Use it

- Search in English. Your words are translated to Japanese for Yahoo, and the Japanese query is shown so you can check it.
- Paste a Yahoo auction link or ID into the search box to open that listing.
- Pick your currency at the top of the page. It starts on NZD and remembers your choice.
- Filter by price, listing type and condition, and sort by things like ending soonest.

## How it works

| Part | Source |
| --- | --- |
| Listings | `server.js` reads the JSON embedded in Yahoo's pages, cached for 60 seconds |
| Translation | Chrome's on-device `Translator` API, in the browser |
| Exchange rates | [open.er-api.com](https://www.exchangerate-api.com), refreshed every 6 hours and saved in `.cache/` |

## Limits

- Translation needs a current desktop Chrome. In other browsers, listings stay in Japanese.
- It's for browsing, not buying. To bid, use Yahoo directly or a proxy service.
- It relies on the structure of Yahoo's pages, so a redesign could break it. It's meant for personal use at normal browsing speed.
