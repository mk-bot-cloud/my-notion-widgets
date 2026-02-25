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
  try {
    console.log("=== 1. ニュース収集（Ledge.ai含む4サイト） ===");
    await fetchNewsDaily();

    console.log("\n=== 2. 自動お掃除（削除チェック済みをアーカイブ） ===");
    await autoCleanupTrash();

    console.log("\n=== 3. 学術大会情報（JSPTスクレイピング） ===");
    if (DB_ACADEMIC_ID) await fetchAllConferences();

    console.log("\n=== 4. PubMed論文要約（Groq AI使用） ===");
    await fillPubmedDataWithAI();

    console.log("\n✨ すべてのタスクが正常に終了しました");
  } catch (e) {
    console.error("メインプロセスでエラー:", e.message);
  }
}

// --- ① ニュース収集機能（文字化け対策版） ---
async function fetchNewsDaily() {
  const sources = [
    { name: "Ledge.ai", url: "https://ledge.ai/feed/" },
    { name: "ICT教育ニュース", url: "https://ict-enews.net/feed/" },
    { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml" },
    { name: "テクノエッジ", url: "https://www.techno-edge.net/rss20/index.rdf" }
  ];
  const keywords = ["AI", "Notion", "Gemini", "効率化", "自動化", "IT", "ChatGPT", "生成AI"];
  const excludeWords = ["開催", "募集", "セミナー", "イベント"];

  for (const source of sources) {
    try {
      const feed = await parser.parseURL(source.url);
      let count = 0;
      for (const item of feed.items.slice(0, 10)) {
        const title = item.title.replace(/[\[【].*?[\]】]/g, '').trim();
        
        if (keywords.some(kw => title.toUpperCase().includes(kw.toUpperCase())) && !excludeWords.some(ew => title.includes(ew))) {
          const exists = await notion.databases.query({ 
            database_id: DB_INPUT_ID, 
            filter: { property: "名前", title: { equals: title } } 
          });
          
          if (exists.results.length === 0) {
            // 画像URLだけ取得（文字化けを防ぐため、本文テキストは取得しない）
            const imageUrl = await getImageUrl(item.link);
            
            // Notionにページを作成（カバー画像＋ブックマーク）
            await createNotionPage(title, item.link, imageUrl, source.name);
            console.log(`✅ ${source.name} 保存: ${title}`);
            count++;
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
    } catch (e) { console.error(`${source.name}取得エラー:`, e.message); }
  }
}

// 画像URL（OGP）のみを安全に抽出
async function getImageUrl(url) {
  try {
    const res = await axios.get(url, { 
      headers: { "User-Agent": "Mozilla/5.0" }, 
      responseType: 'arraybuffer',
      timeout: 5000 
    });
    const html = res.data.toString('utf-8'); 
    const $ = cheerio.load(html);
    return $('meta[property="og:image"]').attr('content') || null;
  } catch (e) { return null; }
}

// Notionページ作成（本文なし・ブックマーク形式）
async function createNotionPage(title, link, imageUrl, sourceName) {
  await notion.pages.create({
    parent: { database_id: DB_INPUT_ID },
    cover: imageUrl ? { type: "external", external: { url: imageUrl } } : null,
    properties: {
      '名前': { title: [{ text: { content: title } }] },
      'URL': { url: link },
      '情報源': { select: { name: sourceName } }
    },
    children: [
      {
        object: "block",
        type: "bookmark",
        bookmark: { url: link }
      }
    ]
  });
}

// --- ② 自動お掃除機能 ---
async function autoCleanupTrash() {
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - 7);
  try {
    const res = await notion.databases.query({
      database_id: DB_INPUT_ID,
      filter: { and: [
        { property: '削除チェック', checkbox: { equals: true } }, 
        { timestamp: 'last_edited_time', last_edited_time: { on_or_before: thresholdDate.toISOString() } }
      ] }
    });
    for (const page of res.results) {
      await notion.pages.update({ page_id: page.id, archived: true });
      console.log(`🗑 アーカイブ済み: ${page.id}`);
    }
  } catch (e) { console.error("お掃除エラー:", e.message); }
}

// --- ③ 学術大会取得機能 ---
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
      const exists = await notion.databases.query({ 
        database_id: DB_ACADEMIC_ID, 
        filter: { property: "URL", url: { equals: conf.url } } 
      });
      if (exists.results.length === 0) {
        await notion.pages.create({
          parent: { database_id: DB_ACADEMIC_ID },
          properties: { 
            '主催学会名': { title: [{ text: { content: conf.organizer } }] }, 
            '大会名称': { rich_text: [{ text: { content: conf.title } }] }, 
            'URL': { url: conf.url } 
          }
        });
        console.log(`✅ 学術大会保存: ${conf.title}`);
      }
    }
  } catch (e) { console.error("学術大会エラー:", e.message); }
}

// --- ④ PubMed要約機能（Groq API使用） ---
async function fillPubmedDataWithAI() {
  const res = await notion.databases.query({
    database_id: DB_INPUT_ID,
    filter: { and: [
      { property: "URL", url: { contains: "pubmed.ncbi.nlm.nih.gov" } }, 
      { property: "タイトル和訳", rich_text: { is_empty: true } }
    ] }
  });

  for (const page of res.results) {
    const url = page.properties.URL.url;
    try {
      const response = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const $ = cheerio.load(response.data);
      const title = $('h1.heading-title').text().trim();
      const abstract = $('.abstract-content').text().trim().substring(0, 1200);
      
      // GroqのRate Limit制限を避けるため30秒待機
      console.log(`PubMed解析中... 制限回避のため30秒待機します: ${title}`);
      await new Promise(r => setTimeout(r, 30000));

      const aiRes = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: `医学論文を日本語で要約しJSONのみ返せ。{"translatedTitle": "和訳", "journal": "雑誌", "summary": "150字要約"}\n\nTitle:${title}\nAbstract:${abstract}` }],
        response_format: { type: "json_object" }
      }, { headers: { "Authorization": `Bearer ${GROQ_KEY}` } });

      const aiData = JSON.parse(aiRes.data.choices[0].message.content);
      await notion.pages.update({
        page_id: page.id,
        properties: {
          "タイトル和訳": { rich_text: [{ text: { content: aiData.translatedTitle } }] },
          "ジャーナル名": { rich_text: [{ text: { content: aiData.journal || "" } }] },
          "要約": { rich_text: [{ text: { content: aiData.summary } }] }
        }
      });
      console.log(`✅ 要約完了: ${aiData.translatedTitle}`);
    } catch (e) { 
      console.error(`PubMed要約エラー [${url}]:`, e.response?.data?.error?.message || e.message); 
    }
  }
}

main();
