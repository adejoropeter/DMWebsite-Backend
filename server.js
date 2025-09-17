// server.js
// Run with Node 18+ and "type": "module" in package.json
import express from "express";
import cors from "cors";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as cheerio from "cheerio";
import pkg from "pg";
import process from "process";
import dotenv from "dotenv";


dotenv.config();

const { Pool } = pkg;

puppeteerExtra.use(StealthPlugin());

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*"); // allow all origins
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.options("*", cors()); 


const PORT = process.env.PORT || 4000;
const LAUNCH_TIMEOUT = 30000;

// ================== POSTGRES DB SETUP ==================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Render/Heroku usually provides DATABASE_URL
  ssl: { rejectUnauthorized: false }, // important for Render/Heroku
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fixtures (
      week TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
await initDB();

// Save fixtures into DB
async function saveFixturesToCache(week, fixtures) {
  await pool.query(
    `INSERT INTO fixtures (week, data, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (week) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [week, JSON.stringify(fixtures)]
  );
}

// Load fixtures from DB
async function loadFixturesFromCache(week) {
  const result = await pool.query(`SELECT data FROM fixtures WHERE week = $1`, [
    week,
  ]);
  return result.rows.length ? result.rows[0].data : null;
}

// ================== SCRAPER HELPERS ==================
const PROXY = process.env.PROXY || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/120.0",
];
function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function launchBrowser() {
  const launchOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-extensions",
      "--single-process",
      "--ignore-certificate-errors",
      "--window-size=1200,900",
    ],
    timeout: LAUNCH_TIMEOUT,
  };

  if (PROXY) launchOptions.args.push(`--proxy-server=${PROXY}`);

  return await puppeteerExtra.launch(launchOptions);
}

async function fetchHtmlWithPuppeteer(url) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    if (PROXY && PROXY_USERNAME && PROXY_PASSWORD) {
      await page.authenticate({ username: PROXY_USERNAME, password: PROXY_PASSWORD });
    }

    await page.setViewport({ width: 1200, height: 900 });
    await page.setUserAgent(randomUserAgent());
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) {
        return req.abort();
      }
      req.continue();
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    try {
      await page.waitForSelector("#table", { timeout: 5000 });
    } catch {}

    const content = await page.content();
    await page.close();
    await browser.close();
    return content;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}

// ================== PARSERS ==================
async function parseFixtures(html) {
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

  return fixtures;
}

async function fetchLatestFixtures() {
  const week = "latest";
  const cached = await loadFixturesFromCache(week);
  if (cached) {
    console.log("Serving fixtures from cache:", week);
    return { week, fixtures: cached, cached: true };
  }

  const url = "https://ablefast.com/";
  const html = await fetchHtmlWithPuppeteer(url);
  const fixtures = await parseFixtures(html);

  await saveFixturesToCache(week, fixtures);
  return { week, fixtures, cached: false };
}

async function fetchFixturesByDate(date) {
  const cached = await loadFixturesFromCache(date);
  if (cached) {
    console.log("Serving fixtures from cache:", date);
    return { week: date, fixtures: cached, cached: true };
  }

  const url = `https://ablefast.com/results/${date}`;
  const html = await fetchHtmlWithPuppeteer(url);
  const fixtures = await parseFixtures(html);

  await saveFixturesToCache(date, fixtures);
  return { week: date, fixtures, cached: false };
}

async function fetchAvailableWeeks() {
  const url = "https://ablefast.com/";
  const html = await fetchHtmlWithPuppeteer(url);
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
}

// ================== API ROUTES ==================
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

// ================== START SERVER ==================
app.listen(PORT, () => {
  console.log(`Pool Fixtures API running on port ${PORT}`);
});
