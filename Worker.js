export default {
  async fetch(request, env) {
    // 1. 设置跨域头 (允许前端从任意域名访问)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", 
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // 2. 处理预检请求 (OPTIONS)
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // 3. 封装统一的 JSON 响应格式
    const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

    // --- 核心逻辑：计算 Key 的哈希值作为 Owner ID ---
    const getOwnerHash = async (key) => {
      // 使用 SHA-256 将 Key 转换为唯一的字符串指纹
      const msgBuffer = new TextEncoder().encode(key.trim());
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    };

    // --- 鉴权函数 ---
    const checkAuth = async (req) => {
      const auth = req.headers.get("Authorization");
      if (!auth) return null;

      // 1. 检查 Key 是否在白名单配置中
      const key1 = env.ADMIN_KEY || "";
      const key2 = env.ADMIN_KEYS || "";
      // 兼容中文逗号和空格
      const allKeys = (key1 + "," + key2).replace(/，/g, ',').split(',').map(k => k.trim()).filter(k => k !== "");
      
      const userKey = auth.trim();
      if (!allKeys.includes(userKey)) return null;

      // 2. 验证通过后，返回该 Key 对应的哈希 ID
      return await getOwnerHash(userKey);
    };

    try {
      const url = new URL(request.url);
      
      // API: 保存笔记 (自动标记 Owner)
      if (url.pathname === "/api/save" && request.method === "POST") {
        const ownerId = await checkAuth(request);
        if (!ownerId) return jsonResponse({ error: "Unauthorized" }, 401);
        
        const body = await request.json();
        const isShare = body.is_share ? 1 : 0;
        
        // 插入时带上 owner 字段
        await env.DB.prepare(
          "INSERT INTO notes (content, is_share, public_id, owner) VALUES (?, ?, ?, ?)"
        ).bind(body.content, isShare, body.public_id || null, ownerId).run();

        return jsonResponse({ success: true });
      }

      // API: 获取列表 (只看自己的)
      if (url.pathname === "/api/list" && request.method === "GET") {
        const ownerId = await checkAuth(request);
        if (!ownerId) return jsonResponse({ error: "Unauthorized" }, 401);

        // SQL 查询增加 owner = ? 条件
        const { results } = await env.DB.prepare(
          "SELECT id, content, created_at FROM notes WHERE is_share = 0 AND owner = ? ORDER BY id DESC"
        ).bind(ownerId).all();

        return jsonResponse(results);
      }

      // API: 删除笔记 (只能删自己的)
      if (url.pathname === "/api/delete" && request.method === "POST") {
        const ownerId = await checkAuth(request);
        if (!ownerId) return jsonResponse({ error: "Unauthorized" }, 401);
        
        const body = await request.json();
        await env.DB.prepare("DELETE FROM notes WHERE id = ? AND owner = ?").bind(body.id, ownerId).run();
        
        return jsonResponse({ success: true });
      }

      // API: AI 总结
      if (url.pathname === "/api/ai-sum" && request.method === "POST") {
        // 1. 鉴权
        if (!(await checkAuth(request))) return jsonResponse({ error: "Unauthorized" }, 401);
        
        // 2. 解析 Body
        let body;
        try {
            body = await request.json();
        } catch(e) {
            return jsonResponse({ error: "Invalid JSON" }, 400);
        }

        // 3. 检查 AI 绑定
        if (!env.AI) return jsonResponse({ summary: "后端未配置 [AI] 绑定，请检查 wrangler.toml" });
        
        // 4. 获取输入内容 (兼容 text/prompt/content 字段，防止 undefined 报错)
        const userInput = body.text || body.prompt || body.content;
        if (!userInput) return jsonResponse({ error: "Empty input text" }, 400);

        try {
            // 5. 调用 AI 模型 (换回 Qwen 1.5)
            const aiRes = await env.AI.run('@cf/qwen/qwen1.5-7b-chat-awq', {
              messages: [
                  { role: "system", content: "你是一个专业的中文笔记助手。请用中文简明扼要地总结用户的笔记内容，提取核心要点。" }, 
                  { role: "user", content: userInput }
              ]
            });

            // 6. 兼容不同的返回格式 (Qwen 通常返回 response)
            const reply = aiRes.response || aiRes.summary || JSON.stringify(aiRes);
            return jsonResponse({ summary: reply });

        } catch (aiError) {
            console.error("AI Error Details:", aiError); // 这会在 Cloudflare Logs 里显示
            return jsonResponse({ error: "AI Service Failed: " + aiError.message }, 500);
        }
      }

      // API: 阅后即焚 (公开访问，凭 ID 读取，无需 Owner 校验)
      const shareMatch = url.pathname.match(/^\/api\/share\/([a-zA-Z0-9]+)$/);
      if (shareMatch && request.method === "GET") {
        const shareId = shareMatch[1];
        const note = await env.DB.prepare("SELECT * FROM notes WHERE public_id = ? AND is_share = 1").bind(shareId).first();
        if (!note) return jsonResponse({ error: "无效链接" }, 404);
        
        // 读取后立即销毁
        await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(note.id).run();
        return jsonResponse({ content: note.content });
      }

      return new Response("CloudNotes Multi-User API Running", { status: 200, headers: corsHeaders });

    } catch (e) {
      // 全局错误捕获
      return jsonResponse({ error: "Internal Server Error: " + e.message }, 500);
    }
  }
};
