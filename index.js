const { Client } = require('@notionhq/client');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_INPUT_ID = process.env.DB_INPUT_ID;
const GROQ_KEY = process.env.GROQ_API_KEY; 
const DB_ACADEMIC_ID = process.env.DB_ACADEMIC_CONFERENCE_ID; 

const parser = new Parser();

async function main() {
  try {
    console.log("=== 1. ニュース収集（RSSリンク微修正） ===");
    await fetchNewsDaily();
    console.log("\n=== 2. 自動お掃除（削除チェック+7日経過分） ===");
    await autoCleanupTrash();
    console.log("\n=== 3. 学術大会情報（重複回避付） ===");
    if (DB_ACADEMIC_ID) await fetchAllConferences();
    console.log("\n=== 4. PubMed要約（である調・200字指定） ===");
    await fillPubmedDataWithAI();
    console.log("\n✨ すべての処理が完了しました");
  } catch (e) { console.error("メイン実行エラー:", e.message); }
}

async function fillPubmedDataWithAI() {
  const res = await notion.databases.query({
    database_id: DB_INPUT_ID,
    filter: { and: [{ property: "URL", url: { contains: "pubmed.ncbi.nlm.nih.gov" } }, { property: "タイトル和訳", rich_text: { is_empty: true } }] }
  });
  
  for (const page of res.results) {
    const url = page.properties.URL.url;
    try {
      const response = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 });
      const $ = cheerio.load(response.data);
      const title = $('h1.heading-title').text().trim() || "タイトル不明";
      const abstract = $('.abstract-content').text().trim().substring(0, 1500) || "Abstractなし";
      const journal = $('.journal-actions-trigger').first().text().trim() || "不明";

      console.log(`Groq解析中... ${title.substring(0, 20)}`);
      await new Promise(r => setTimeout(r, 30000));

      const prompt = `あなたは医学論文の専門家です。以下の抄録を読み、指定形式のJSONで返答せよ。
1. translatedTitle: 日本語タイトル
2. journal: ジャーナル名
3. summary: 以下の制約を厳守。
   - 語尾は「である」「だ」「～を認めた」等の「である・だ調」とする（「ですます」禁止）。
   - 文字数は200字程度。背景、方法、結果、結論をバランスよく含めること。

Title: ${title}\nJournal: ${journal}\nAbstract: ${abstract}`;

      const aiRes = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        response_format: { type: "json_object" }
      }, { headers: { "Authorization": `Bearer ${GROQ_KEY.trim()}`, "Content-Type": "application/json" } });

      const aiData = JSON.parse(aiRes.data.choices[0].message.content);
      const limitSummary = aiData.summary && aiData.summary.length > 200 ? aiData.summary.substring(0, 198) : aiData.summary;

      await notion.pages.update({
        page_id: page.id,
        properties: {
          "タイトル和訳": { rich_text: [{ text: { content: aiData.translatedTitle || "" } }] },
          "ジャーナル名": { rich_text: [{ text: { content: aiData.journal || journal } }] },
          "要約": { rich_text: [{ text: { content: limitSummary || "" } }] }
        }
      });
      console.log("✅ 要約完了");
    } catch (e) { console.error(`❌ PubMedエラー: ${e.message}`); }
  }
}

async function fetchNewsDaily() {
  const sources = [
    { name: "Ledge.ai", url: "https://ledge.ai/feed" }, // 末尾スラッシュ削除で試行
    { name: "ICT教育ニュース", url: "https://ict-enews.net/feed/" },
    { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml" },
    { name: "テクノエッジ", url: "https://www.techno-edge.net/rss20/index.rdf" }
  ];
  const keywords = ["AI", "Notion", "Gemini", "効率化", "自動化", "IT", "ChatGPT", "生成AI", "教育", "DX"];

  for (const source of sources) {
    try {
      const feed = await parser.parseURL(source.url);
      for (const item of feed.items.slice(0, 8)) {
        const title = item.title.replace(/[\[【].*?[\]】]/g, '').trim();
        if (keywords.some(kw => title.toUpperCase().includes(kw.toUpperCase()))) {
          const exists = await notion.databases.query({ database_id: DB_INPUT_ID, filter: { property: "名前", title: { equals: title } } });
          if (exists.results.length === 0) {
            const imageUrl = await getImageUrl(item);
            await createNotionPage(title, item.link, imageUrl, source.name);
            console.log(`✅ ${source.name} 保存: ${title}`);
          }
        }
      }
    } catch (e) { console.error(`${source.name}エラー: ${e.message}`); }
  }
}

async function getImageUrl(item) {
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  try {
    const res = await axios.get(item.link, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 5000 });
    const $ = cheerio.load(res.data);
    return $('meta[property="og:image"]').attr('content') || null;
  } catch (e) { return null; }
}

async function createNotionPage(title, link, imageUrl, sourceName) {
  const children = imageUrl ? [{ object: "block", type: "image", image: { type: "external", external: { url: imageUrl } } }] : [];
  children.push({ object: "block", type: "bookmark", bookmark: { url: link } });
  await notion.pages.create({
    parent: { database_id: DB_INPUT_ID },
    cover: imageUrl ? { type: "external", external: { url: imageUrl } } : null,
    properties: { '名前': { title: [{ text: { content: title } }] }, 'URL': { url: link }, '情報源': { select: { name: sourceName } } },
    children: children
  });
}

async function autoCleanupTrash() {
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - 7);
  try {
    const res = await notion.databases.query({
      database_id: DB_INPUT_ID,
      filter: { and: [{ property: '削除チェック', checkbox: { equals: true } }, { property: '作成日時', date: { on_or_before: thresholdDate.toISOString() } }] }
    });
    for (const page of res.results) { 
        await notion.pages.update({ page_id: page.id, archived: true }); 
        console.log(`🗑️ アーカイブ完了: ${page.id}`);
    }
  } catch (e) { console.error("お掃除エラー:", e.message); }
}

async function fetchAllConferences() {
  try {
    const res = await axios.get("https://www.jspt.or.jp/conference/", { headers: { "User-Agent": "Mozilla/5.0" } });
    const $ = cheerio.load(res.data);
    $('table tbody tr').each(async (i, el) => {
      const cells = $(el).find('td');
      if (cells.length >= 4) {
        const title = $(cells[1]).text().trim();
        const link = $(cells[1]).find('a').attr('href');
        if (link && link.startsWith('http')) {
          const exists = await notion.databases.query({ database_id: DB_ACADEMIC_ID, filter: { property: "URL", url: { equals: link } } });
          if (exists.results.length === 0) {
            await notion.pages.create({ parent: { database_id: DB_ACADEMIC_ID }, properties: { '主催学会名': { title: [{ text: { content: $(cells[0]).text().trim() } }] }, '大会名称': { rich_text: [{ text: { content: title } }] }, 'URL': { url: link } } });
          }
        }
      }
    });
  } catch (e) { console.error("学術大会エラー:", e.message); }
}

main();
