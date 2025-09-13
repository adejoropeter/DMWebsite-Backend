import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import https from "https";

const app = express();
app.use(cors());

// ✅ custom https agent for TLS fix
const agent = new https.Agent({
  rejectUnauthorized: false, // ignore SSL validation
  keepAlive: true,
});
const PORT = process.env.PORT || 4000;

// ✅ helper to fetch HTML safely
async function fetchHtml(url) {
  const res = await axios.get(url, {
    httpsAgent: agent,
    timeout: 20000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  return res.data;
}

// Scrape fixtures or results from AbleFast homepage
async function fetchLatestFixtures() {
  try {
    const html = await fetchHtml("https://ablefast.com/");
    const $ = cheerio.load(html);

    const fixtures = [];

    $("#table tbody tr").each((i, row) => {
      const cols = $(row).find("td");

      const number = $(cols[0]).text().trim();
      const home = $(cols[1]).text().trim();
      const away = $(cols[3]).text().trim();
      const result = $(cols[4]).text().trim();
      const status = $(cols[5]).text().trim();

      if (number && home && away) {
        fixtures.push({ number, home, away, result, status });
      }
    });

    return { week: "latest", fixtures };
  } catch (err) {
    console.error("Failed to fetch latest:", err.message);
    return { week: "latest", fixtures: [] };
  }
}

// Scrape fixtures/results for a given week (date string)
async function fetchFixturesByDate(date) {
  try {
    const html = await fetchHtml(`https://ablefast.com/results/${date}`);
    const $ = cheerio.load(html);

    const fixtures = [];
    $("#table tbody tr").each((i, row) => {
      const cols = $(row).find("td");

      const number = $(cols[0]).text().trim();
      const home = $(cols[1]).text().trim();
      const away = $(cols[3]).text().trim();
      const result = $(cols[4]).text().trim();
      const status = $(cols[5]).text().trim();

      if (number && home && away) {
        fixtures.push({ number, home, away, result, status });
      }
    });

    return { week: date, fixtures };
  } catch (err) {
    console.error(`Failed to fetch fixtures for ${date}:`, err.message);
    return { week: date, fixtures: [] };
  }
}

// Scrape available weeks/dates from AbleFast
async function fetchAvailableWeeks() {
  try {
    const html = await fetchHtml("https://ablefast.com/");
    const $ = cheerio.load(html);

    const weeks = [];
    $("select option").each((i, el) => {
      const value = $(el).attr("value");
      const label = $(el).text().trim();
      if (value && value.includes("-")) {
        weeks.push({ date: value, label });
      }
    });

    return weeks;
  } catch (err) {
    console.error("Failed to fetch weeks:", err.message);
    return [];
  }
}

// API routes
app.get("/api/fixtures", async (req, res) => {
  const result = await fetchLatestFixtures();
  res.json(result);
});

app.get("/api/weeks", async (req, res) => {
  const weeks = await fetchAvailableWeeks();
  res.json(weeks);
});

app.get("/api/fixtures/:date", async (req, res) => {
  const { date } = req.params;
  const result = await fetchFixturesByDate(date);
  res.json(result);
});

// Start server
app.listen(PORT, () => {
  console.log("Pool Fixtures API running on port", PORT);
});
