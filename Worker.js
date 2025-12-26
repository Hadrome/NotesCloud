export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 1. 设置跨域头
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", 
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 2. 核心鉴权逻辑 (修复了读取不到 ADMIN_KEYS 的问题)
    const checkAuth = (req) => {
      const auth = req.headers.get("Authorization");
      if (!auth) return false; // 前端没发 Key，直接拒绝

      // 获取 Cloudflare 环境变量
      const key1 = env.ADMIN_KEY || "";
      const key2 = env.ADMIN_KEYS || ""; // 确保这里和后台变量名完全一致（全大写）

      // 将两个变量合并，并处理中文逗号、首尾空格
      const allKeys = (key1 + "," + key2)
        .replace(/，/g, ',')      // 把中文逗号转成英文逗号
        .split(',')               // 分割
        .map(k => k.trim())       // 去掉每一项的空格
        .filter(k => k !== "");   // 去掉空项

      // 调试日志（如果还不行，可以在 Cloudflare 实时日志里看到）
      console.log(`前端发来: [${auth}], 后端白名单: ${JSON.stringify(allKeys)}`);

      // 只要发来的 Key 在白名单里，就通过
      return allKeys.includes(auth.trim());
    };

    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status: status,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    };

    try {
      // API: 保存
      if (path === "/api/save" && request.method === "POST") {
        if (!checkAuth(request)) {
          // 真正上线时可以把 details 去掉
          return jsonResponse({ error: "暗号错误", details: "Key not in AllowList" }, 401);
        }
        
        const body = await request.json();
        const isShare = body.is_share ? 1 : 0;
        await env.DB.prepare(
          "INSERT INTO notes (content, is_share, public_id) VALUES (?, ?, ?)"
        ).bind(body.content, isShare, body.public_id || null).run();

        return jsonResponse({ success: true });
      }

      // API: 列表
      if (path === "/api/list" && request.method === "GET") {
        if (!checkAuth(request)) return jsonResponse({ error: "暗号错误" }, 401);

        const { results } = await env.DB.prepare(
          "SELECT id, content, created_at FROM notes WHERE is_share = 0 ORDER BY id DESC"
        ).all();

        return jsonResponse(results);
      }

      // API: 删除
      if (path === "/api/delete" && request.method === "POST") {
        if (!checkAuth(request)) return jsonResponse({ error: "暗号错误" }, 401);
        
        const body = await request.json();
        await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(body.id).run();
        
        return jsonResponse({ success: true });
      }

      // API: AI
      if (path === "/api/ai-sum" && request.method === "POST") {
        if (!checkAuth(request)) return jsonResponse({ error: "暗号错误" }, 401);

        const body = await request.json();
        if (!env.AI) return jsonResponse({ summary: "未绑定 AI 模型" });

        const aiRes = await env.AI.run('@cf/qwen/qwen1.5-7b-chat-awq', {
          messages: [
            { role: "system", content: "你是一个专业的笔记助手。请用中文简明扼要地总结用户的笔记内容。" },
            { role: "user", content: body.text }
          ]
        });

        return jsonResponse({ summary: aiRes.response });
      }

      // API: 阅后即焚
      const shareMatch = path.match(/^\/api\/share\/([a-zA-Z0-9]+)$/);
      if (shareMatch && request.method === "GET") {
        const shareId = shareMatch[1];
        const note = await env.DB.prepare(
          "SELECT * FROM notes WHERE public_id = ? AND is_share = 1"
        ).bind(shareId).first();

        if (!note) return jsonResponse({ error: "链接失效" }, 404);
        await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(note.id).run();
        return jsonResponse({ content: note.content });
      }

      return new Response("API Running", { status: 200, headers: corsHeaders });

    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
};
