const { Client } = require('@notionhq/client');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_INPUT_ID = process.env.DB_INPUT_ID;
const GROQ_KEY = process.env.GROQ_API_KEY; 
const DB_ACADEMIC_ID = process.env.DB_ACADEMIC_CONFERENCE_ID; 
const DB_ACTION_ID = process.env.DB_Action_ID; // ★ Secretsから取得

const parser = new Parser();

async function main() {
  try {
    console.log("=== 1. ニュース収集 ===");
    await fetchNewsDaily();
    console.log("\n=== 2. 自動お掃除 ===");
    await autoCleanupTrash();
    console.log("\n=== 3. 学術大会情報 ===");
    if (DB_ACADEMIC_ID) await fetchAllConferences();
    console.log("\n=== 4. PubMed要約 ===");
    await fillPubmedDataWithAI();

    // --- ★ 追加機能：ここから ---
    console.log("\n=== 5. 蓄積された要約から『問い』を生成 ===");
    if (DB_ACTION_ID) await generateQuestionsFromSummaries();
    // --- ★ 追加機能：ここまで ---

    console.log("\n✨ すべての処理が正常に完了しました");
  } catch (e) { console.error("メイン実行エラー:", e.message); }
}

// ==========================================
// ★ 新機能：DB_Actionに「問い」を自動生成する
// ==========================================
async function generateQuestionsFromSummaries() {
  try {
    // 1. Make経由or手動要約分からPubMed論文を10件取得
    const res = await notion.databases.query({
      database_id: DB_INPUT_ID,
      filter: {
        and: [
          { property: "URL", url: { contains: "pubmed.ncbi.nlm.nih.gov" } },
          { property: "要約", rich_text: { is_not_empty: true } }
        ]
      },
      sorts: [{ property: "作成日時", direction: "descending" }],
      page_size: 10
    });

    if (res.results.length === 0) {
      console.log("分析対象の要約済み論文が見つかりませんでした。");
      return;
    }

    // 2. AIに渡すための要約リストを作成
    const materials = res.results.map(page => {
      const title = page.properties['タイトル和訳']?.rich_text[0]?.plain_text || "無題";
      const summary = page.properties['要約']?.rich_text[0]?.plain_text || "";
      return `【${title}】: ${summary}`;
    }).join("\n\n");

    // 3. Groqに「問い」を考えさせる
    const prompt = `あなたは理学療法の専門家かつ研究者です。以下の複数の論文要約を読み、これらを組み合わせて「次に解決すべき医学的な問い」を日本語で3つ作成してください。
    出力は必ずJSON形式にしてください。
    { "actions": [ { "q": "問いの内容", "reason": "背景" } ] }
    
    論文リスト:
    ${materials}`;

    const aiRes = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    }, { headers: { "Authorization": `Bearer ${GROQ_KEY.trim()}`, "Content-Type": "application/json" } });

    const aiData = JSON.parse(aiRes.data.choices[0].message.content);

    // 4. DB_Action（問いDB）に書き込む
    for (const item of aiData.actions) {
      const exists = await notion.databases.query({
        database_id: DB_ACTION_ID,
        filter: { property: "問い", title: { equals: item.q } }
      });

      if (exists.results.length === 0) {
        await notion.pages.create({
          parent: { database_id: DB_ACTION_ID },
          properties: {
            '問い': { title: [{ text: { content: item.q } }] },
            'ステータス': { select: { name: "未解決" } }
          },
          children: [{ 
            object: "block", 
            type: "paragraph", 
            paragraph: { rich_text: [{ text: { content: `🤖 AI考察: ${item.reason}` } }] } 
          }]
        });
        console.log(`✅ 新しい問いを生成: ${item.q}`);
      }
    }
  } catch (e) { console.error("問い生成エラー:", e.message); }
}

// ==========================================
// 既存の関数（変更なし）
// ==========================================
async function fetchAllConferences() {
  try {
    const res = await axios.get("https://www.jspt.or.jp/conference/", { headers: { "User-Agent": "Mozilla/5.0" } });
    const $ = cheerio.load(res.data);
    const rows = $('table tbody tr').get();
    for (const row of rows) {
      const cells = $(row).find('td');
      if (cells.length >= 5) {
        const conferenceCell = $(cells[1]);
        const conferenceName = conferenceCell.text().trim();
        const link = conferenceCell.find('a').attr('href');
        const dateText = $(cells[2]).text().trim();
        const venueText = $(cells[3]).text().trim();
        const remarksText = $(cells[4]).text().trim();
        if (link && link.startsWith('http')) {
          const exists = await notion.databases.query({ database_id: DB_ACADEMIC_ID, filter: { property: "URL", url: { equals: link } } });
          if (exists.results.length === 0) {
            await notion.pages.create({
              parent: { database_id: DB_ACADEMIC_ID },
              properties: {
                '大会名称': { title: [{ text: { content: conferenceName } }] },
                'URL': { url: link },
                '開催年月日': { rich_text: [{ text: { content: dateText } }] },
                '会場': { rich_text: [{ text: { content: venueText } }] },
                '備考': { rich_text: [{ text: { content: remarksText } }] }
              }
            });
            console.log(`✅ 大会登録: ${conferenceName}`);
          }
        }
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
      const response = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 });
      const $ = cheerio.load(response.data);
      const title = $('h1.heading-title').text().trim() || "タイトル不明";
      const abstract = $('.abstract-content').text().trim().substring(0, 1500) || "Abstractなし";
      const journal = $('.journal-actions-trigger').first().text().trim() || "不明";
      await new Promise(r => setTimeout(r, 20000));
      const prompt = `あなたは医学論文の専門家です。抄録を読み、JSONで返せ。1. translatedTitle, 2. journal, 3. summary: である調で180〜200字。\n\nTitle: ${title}\nAbstract: ${abstract}`;
      const aiRes = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        response_format: { type: "json_object" }
      }, { headers: { "Authorization": `Bearer ${GROQ_KEY.trim()}`, "Content-Type": "application/json" } });
      const aiData = JSON.parse(aiRes.data.choices[0].message.content);
      await notion.pages.update({
        page_id: page.id,
        properties: {
          "タイトル和訳": { rich_text: [{ text: { content: aiData.translatedTitle || "" } }] },
          "ジャーナル名": { rich_text: [{ text: { content: aiData.journal || journal } }] },
          "要約": { rich_text: [{ text: { content: aiData.summary || "" } }] }
        }
      });
    } catch (e) { console.error(`❌ PubMedエラー: ${e.message}`); }
  }
}

async function fetchNewsDaily() {
  const sources = [
    { name: "ICT教育ニュース", url: "https://ict-enews.net/feed/" },
    { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml" },
    { name: "テクノエッジ", url: "https://www.techno-edge.net/rss20/index.rdf" }
  ];
  const keywords = ["AI", "Notion", "Gemini", "効率化", "自動化", "IT", "ChatGPT", "生成AI", "理学療法"];
  for (const source of sources) {
    try {
      const feed = await parser.parseURL(source.url);
      for (const item of feed.items.slice(0, 5)) {
        const title = item.title.replace(/[\[【].*?[\]】]/g, '').trim();
        if (keywords.some(kw => title.toUpperCase().includes(kw.toUpperCase()))) {
          const exists = await notion.databases.query({ database_id: DB_INPUT_ID, filter: { property: "名前", title: { equals: title } } });
          if (exists.results.length === 0) {
            const imageUrl = await getImageUrl(item);
            await createNotionPage(title, item.link, imageUrl, source.name);
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
    for (const page of res.results) { await notion.pages.update({ page_id: page.id, archived: true }); }
  } catch (e) { console.error("お掃除エラー:", e.message); }
}

main();
