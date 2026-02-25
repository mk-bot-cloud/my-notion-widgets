const { Client } = require('@notionhq/client');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');

// 環境変数の取得
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_INPUT_ID = process.env.DB_INPUT_ID;
const GROQ_KEY = process.env.GROQ_API_KEY;
const DB_ACADEMIC_ID = process.env.DB_ACADEMIC_CONFERENCE_ID; 

const parser = new Parser();

async function main() {
  console.log("=== 1. ニュース収集（GAS ①の移行） ===");
  await fetchNewsDaily();

  console.log("\n=== 2. 自動お掃除（GAS ②の移行） ===");
  await autoCleanupTrash();

  console.log("\n=== 3. 学術大会情報（GAS ③の移行） ===");
  if (DB_ACADEMIC_ID) await fetchAllConferences();

  console.log("\n=== 4. PubMed要約（GAS ④の移行・エラー対策版） ===");
  await fillPubmedDataWithAI();
}

// --- ① ニュース収集 ---
async function fetchNewsDaily() {
  const sources = [
    { name: "ICT教育ニュース", url: "https://ict-enews.net/feed/" },
    { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml" },
    { name: "テクノエッジ", url: "https://www.techno-edge.net/rss20/index.rdf" }
  ];
  const keywords = ["AI", "Notion", "Gemini", "効率化", "自動化", "IT", "学校", "教育", "ChatGPT", "生成AI"];
  const excludeWords = ["開催", "募集", "セミナー", "ウェビナー", "登壇", "申込", "イベント"];

  for (const source of sources) {
    try {
      const feed = await parser.parseURL(source.url);
      let count = 0;
      for (const item of feed.items) {
        if (count >= 10) break;
        const title = item.title.replace(/[\[【].*?[\]】]/g, '').replace(/^ITmedia\s*[:：]\s*/g, '').trim();
        const isHit = keywords.some(kw => title.toUpperCase().includes(kw.toUpperCase()));
        const isExcluded = excludeWords.some(ew => title.includes(ew));

        if (isHit && !isExcluded) {
          const exists = await notion.databases.query({ database_id: DB_INPUT_ID, filter: { property: "名前", title: { equals: title } } });
          if (exists.results.length === 0) {
            await notion.pages.create({
              parent: { database_id: DB_INPUT_ID },
              properties: { '名前': { title: [{ text: { content: title } }] }, 'URL': { url: item.link } }
            });
            console.log(`✅ 保存: ${title}`);
            count++;
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
    } catch (e) { console.error(`${source.name}でエラー:`, e.message); }
  }
}

// --- ② 自動お掃除 ---
async function autoCleanupTrash() {
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - 7);
  
  try {
    const res = await notion.databases.query({
      database_id: DB_INPUT_ID,
      filter: { and: [{ property: '削除チェック', checkbox: { equals: true } }, { timestamp: 'last_edited_time', last_edited_time: { on_or_before: thresholdDate.toISOString() } }] }
    });
    for (const page of res.results) {
      await notion.pages.update({ page_id: page.id, archived: true });
      console.log(`🗑 アーカイブ: ${page.id}`);
    }
  } catch (e) { console.error("掃除エラー:", e.message); }
}

// --- ③ 学術大会取得（GitHub向け調整版） ---
async function fetchAllConferences() {
  const url = "https://www.jspt.or.jp/conference/";
  try {
    const res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const $ = cheerio.load(res.data);
    const conferences = [];
    
    $('table tbody tr').each((i, el) => {
      const cells = $(el).find('td');
      if (cells.length >= 4) {
        const title = $(cells[1]).text().trim();
        const link = $(cells[1]).find('a').attr('href');
        if (link && link.startsWith('http')) {
          conferences.push({ organizer: $(cells[0]).text().trim(), title, url: link });
        }
      }
    });

    for (const conf of conferences.slice(0, 5)) {
      const exists = await notion.databases.query({ database_id: DB_ACADEMIC_ID, filter: { property: "URL", url: { equals: conf.url } } });
      if (exists.results.length === 0) {
        await notion.pages.create({
          parent: { database_id: DB_ACADEMIC_ID },
          properties: { '主催学会名': { title: [{ text: { content: conf.organizer } }] }, '大会名称': { rich_text: [{ text: { content: conf.title } }] }, 'URL': { url: conf.url } }
        });
        console.log(`✅ 大会保存: ${conf.title}`);
      }
    }
  } catch (e) { console.error("学術大会エラー:", e.message); }
}

// --- ④ PubMed要約（Rate Limit 徹底対策版） ---
async function fillPubmedDataWithAI() {
  const res = await notion.databases.query({
    database_id: DB_INPUT_ID,
    filter: { and: [{ property: "URL", url: { contains: "pubmed.ncbi.nlm.nih.gov" } }, { property: "タイトル和訳", rich_text: { is_empty: true } }] }
  });

  for (const page of res.results) {
    const url = page.properties.URL.url;
    try {
      console.log(`📝 PubMed解析中: ${url}`);
      const response = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const $ = cheerio.load(response.data);
      
      const title = $('h1.heading-title').text().trim();
      const abstract = $('.abstract-content').text().trim().substring(0, 1200); // さらに短縮

      // Rate limit 回避のため、1件ごとに「30秒」待機（無料枠だとこれくらい必要です）
      console.log("Groq制限回避のため30秒待機します...");
      await new Promise(r => setTimeout(r, 30000));

      const aiRes = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: `医学論文を日本語で短く要約しJSONのみ返せ。{"translatedTitle": "和訳", "journal": "雑誌", "summary": "150字要約"}\n\nTitle:${title}\nAbstract:${abstract}` }],
        response_format: { type: "json_object" }
      }, { headers: { "Authorization": `Bearer ${GROQ_KEY}` } });

      const aiData = JSON.parse(aiRes.data.choices[0].message.content);
      
      await notion.pages.update({
        page_id: page.id,
        properties: {
          "タイトル和訳": { rich_text: [{ text: { content: aiData.translatedTitle } }] },
          "ジャーナル名": { rich_text: [{ text: { content: aiData.journal || "" } }] },
          "要約": { rich_text: [{ text: { content: aiData.summary.substring(0, 200) } }] }
        }
      });
      console.log(`✅ 要約完了: ${aiData.translatedTitle}`);

    } catch (e) { console.error(`❌ エラー:`, e.response?.data?.error?.message || e.message); }
  }
}

main();
