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
  console.log("=== 1. ニュース収集（Ledge.ai追加 / 写真・本文抽出あり） ===");
  await fetchNewsDaily();

  console.log("\n=== 2. 自動お掃除 ===");
  await autoCleanupTrash();

  console.log("\n=== 3. 学術大会情報 ===");
  if (DB_ACADEMIC_ID) await fetchAllConferences();

  console.log("\n=== 4. PubMed要約 ===");
  await fillPubmedDataWithAI();
}

// --- ① ニュース収集機能 ---
async function fetchNewsDaily() {
  const sources = [
    { name: "Ledge.ai", url: "https://ledge.ai/feed/" }, // Ledgeを追加
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
          const exists = await notion.databases.query({ database_id: DB_INPUT_ID, filter: { property: "名前", title: { equals: title } } });
          
          if (exists.results.length === 0) {
            // 本文と画像の抽出を実行
            const contentData = await extractContent(item.link);
            
            // Notionにページを作成（カバー画像と本文付き）
            await createNotionPageWithContent(title, item.link, contentData, source.name);
            console.log(`✅ ${source.name} 保存: ${title}`);
            count++;
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
    } catch (e) { console.error(`${source.name}エラー:`, e.message); }
  }
}

// 記事URLから画像と本文を抜き出す関数
async function extractContent(url) {
  try {
    const res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const $ = cheerio.load(res.data);
    
    // サムネイル画像 (og:image)
    const imageUrl = $('meta[property="og:image"]').attr('content');
    
    // 本文の抽出（主要なクラス名を網羅）
    let bodyText = "";
    const contentSelector = '.article-body, .entry-content, #cmsBody, .innerText, .l-article-content';
    $(contentSelector).find('script, style, .ad, .social').remove(); // 不要なものを削除
    bodyText = $(contentSelector).text().replace(/\s+/g, ' ').trim();

    return { image: imageUrl, body: bodyText || "本文の取得に失敗しました。詳細はリンク先を確認してください。" };
  } catch (e) {
    return { image: null, body: "コンテンツの取得中にエラーが発生しました。" };
  }
}

// Notionページ作成処理
async function createNotionPageWithContent(title, link, data, sourceName) {
  const children = [];
  
  // ページ内に画像ブロックを追加
  if (data.image) {
    children.push({ object: "block", type: "image", image: { type: "external", external: { url: data.image } } });
  }

  // 本文を2000文字ずつに分割して追加
  const textBody = data.body.substring(0, 4000); // 念のため最大4000字程度に制限
  const chunks = textBody.match(/[\s\S]{1,2000}/g) || [textBody];
  chunks.forEach(chunk => {
    children.push({ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: chunk } }] } });
  });

  // 最後にブックマークを追加
  children.push({ object: "block", type: "bookmark", bookmark: { url: link } });

  await notion.pages.create({
    parent: { database_id: DB_INPUT_ID },
    cover: data.image ? { type: "external", external: { url: data.image } } : null, // カバー画像に設定
    properties: {
      '名前': { title: [{ text: { content: title } }] },
      'URL': { url: link },
      '情報源': { select: { name: sourceName } } // セレクトプロパティがある場合
    },
    children: children
  });
}

// --- ②自動お掃除、③学術大会、④PubMed（前回から引き継ぎ） ---
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
    }
  } catch (e) { console.error("お掃除エラー:", e.message); }
}

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
      }
    }
  } catch (e) { console.error("学術大会エラー:", e.message); }
}

async function fillPubmedDataWithAI() {
  const res = await notion.databases.query({
    database_id: DB_INPUT_ID,
    filter: { and: [{ property: "URL", url: { contains: "pubmed.ncbi.nlm.nih.gov" } }, { property: "タイトル和訳", rich_text: { is_empty: true } }] }
  });
  for (const page of res.results) {
    const url = page.properties.URL.url;
    try {
      const response = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const $ = cheerio.load(response.data);
      const title = $('h1.heading-title').text().trim();
      const abstract = $('.abstract-content').text().trim().substring(0, 1200);
      
      console.log("Groq待機(30秒)...");
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
    } catch (e) { console.error(`PubMedエラー:`, e.message); }
  }
}

main();
