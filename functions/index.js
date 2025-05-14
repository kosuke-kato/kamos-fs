// functions/index.js
const functions = require("firebase-functions"); // Firebase Cloud Functions v1 SDK
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cors = require("cors")({origin: true}); // CORSミドルウェアをインポート

const API_KEY = functions.config().gemini ? functions.config().gemini.key : undefined;

let genAI;
if (API_KEY) {
    genAI = new GoogleGenerativeAI(API_KEY);
    console.log("[Cloud Function] Gemini AI Client initialized with API Key.");
} else {
    console.error(
        "FATAL ERROR: Gemini API key not set in Firebase Functions config. " +
        "Run 'firebase functions:config:set gemini.key=\"YOUR_API_KEY\"' in your project root and redeploy."
    );
}

const runtimeOpts = {
  timeoutSeconds: 300, 
  memory: '1GB'
};

// 呼び出し可能な関数 (onCall) を使用しつつ、CORSミドルウェアを適用するラッパーを作成
// 注意: onCallトリガーで直接corsミドルウェアを適用するのは一般的ではありません。
// 通常、onCallはFirebase SDKがCORSを処理します。
// このエラーがデプロイ環境で継続する場合、関数の呼び出し方やプロジェクト設定に起因する可能性があります。
// まずはリージョン指定やエミュレータ設定を確認し、それでも解決しない場合の最終手段として検討します。
// ここでは、呼び出し可能な関数として定義し、CORSの問題がクライアント側の設定や
// Firebaseプロジェクトの何らかの特殊な設定に起因している可能性を考慮します。
// もし、通常のHTTPS onRequestトリガーに変更する場合は、CORSミドルウェアの使い方がより直接的になります。

exports.callKamosFsAnalysis = functions.runWith(runtimeOpts).https.onCall(async (data, context) => {
    // onCallトリガーでは、通常Firebase SDKがCORSを処理します。
    // このエラーがデプロイ環境で発生している場合、以下の点を確認してください:
    // 1. フロントエンドから正しいリージョンの関数を呼び出しているか。
    // 2. FirebaseプロジェクトのAPI設定で、呼び出し元オリジンが制限されていないか。

    if (!API_KEY || !genAI) {
         console.error("[callKamosFsAnalysis] Gemini API key is not configured or genAI client failed to initialize.");
         throw new functions.https.HttpsError(
             'internal',
             'The server is not configured correctly to call the Gemini API. Please contact the administrator.'
         );
    }

    const analysisTarget = data.analysisTarget;
    const specificPrompts = data.specificPrompts; 

    if (!analysisTarget || typeof analysisTarget !== 'string' || analysisTarget.trim() === "") {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with "analysisTarget" argument which must be a non-empty string.');
    }
    if (!specificPrompts || typeof specificPrompts !== 'object' || Object.keys(specificPrompts).length === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with "specificPrompts" argument which must be a non-empty object containing cell prompts.');
    }

    console.log(`[Cloud Function - callKamosFsAnalysis] Received request for target: "${analysisTarget}" with ${Object.keys(specificPrompts).length} prompts.`);

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" }); 
        const results = {}; 
        const generationConfig = { /* temperature: 0.7, maxOutputTokens: 1024 */ };

        const analysisPromises = Object.entries(specificPrompts).map(async ([cellId, promptText]) => {
            if (typeof promptText !== 'string' || promptText.trim() === "") {
                console.warn(`[Cloud Function - callKamosFsAnalysis] Skipping empty or invalid prompt for cellId: ${cellId}`);
                return [cellId, "[プロンプトが空または無効です]"];
            }
            
            const fullPrompt = `分析対象のプロジェクト概要: "${analysisTarget}"\n\n以下の問いに対する詳細な分析と考察を生成してください。\n問い: ${promptText}\n\n分析結果と考察:`;
            console.log(`[Cloud Function - callKamosFsAnalysis] Sending prompt to Gemini for cellId ${cellId}. Prompt (start): "${promptText.substring(0,100)}..."`);
            
            try {
                const chat = model.startChat({ generationConfig, history: [] });
                const result = await chat.sendMessage(fullPrompt);
                const response = result.response;
                const text = response.text(); 
                console.log(`[Cloud Function - callKamosFsAnalysis] Received response from Gemini for cellId ${cellId}. Response (start): "${text.substring(0,100)}..."`);
                return [cellId, text]; 
            } catch (apiError) {
                console.error(`[Cloud Function - callKamosFsAnalysis] Error calling Gemini API for cellId ${cellId}:`, apiError.message);
                if (apiError.response && apiError.response.data) { 
                    console.error("[Cloud Function - callKamosFsAnalysis] Gemini API Error Details:", JSON.stringify(apiError.response.data, null, 2));
                } else if (apiError.safetySettings) { 
                     console.error("[Cloud Function - callKamosFsAnalysis] Gemini API call blocked due to safety settings. Details:", JSON.stringify(apiError.safetySettings, null, 2));
                     return [cellId, `[${cellId}の分析結果がAIの安全基準によりブロックされました]`];
                }
                return [cellId, `[${cellId}の分析中にAPIエラーが発生しました: ${apiError.message}]`];
            }
        });

        const settledResults = await Promise.all(analysisPromises);
        
        for (const [cellId, analysisText] of settledResults) {
            results[cellId] = analysisText;
        }

        console.log("[Cloud Function - callKamosFsAnalysis] Returning structured results to client (showing keys):", Object.keys(results));
        return { results }; 

    } catch (error) {
        console.error("[Cloud Function - callKamosFsAnalysis] Error in function execution:", error);
        throw new functions.https.HttpsError('internal', `An error occurred while processing the analysis. ${error.message}`);
    }
});