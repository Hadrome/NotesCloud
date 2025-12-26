export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // --- CORS 配置 (允许跨域) ---
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", // 为了安全，生产环境可以将 * 改为你的前端域名
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // 处理预检请求 (Browser Preflight)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- 修改后的鉴权辅助函数 ---
    const checkAuth = (req) => {
      const auth = req.headers.get("Authorization");
      
      // 1.以此确保环境变量存在
      if (!env.ADMIN_KEY) return false;
      
      // 2. 将环境变量按逗号分割，并去除每个 Key 两端的空格
      // 例如 "key1, key2" 变成 ["key1", "key2"]
      const validKeys = env.ADMIN_KEY.split(',').map(k => k.trim());
      
      // 3. 检查前端发来的 auth 是否在这个数组里
      // 注意：这里需要确保 auth 不为空
      return auth && validKeys.includes(auth);
    };

    // 通用响应辅助函数
    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status: status,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders // 每个响应都带上 CORS 头
        }
      });
    };

    try {
      // --- API 路由 ---

      // 1. 保存笔记 (POST /api/save)
      if (path === "/api/save" && request.method === "POST") {
        if (!checkAuth(request)) return jsonResponse({ error: "Unauthorized" }, 401);
        
        const body = await request.json();
        const isShare = body.is_share ? 1 : 0;
        const publicId = body.public_id || null;
        
        await env.DB.prepare(
          "INSERT INTO notes (content, is_share, public_id) VALUES (?, ?, ?)"
        ).bind(body.content, isShare, publicId).run();

        return jsonResponse({ success: true });
      }

      // 2. 获取列表 (GET /api/list)
      if (path === "/api/list" && request.method === "GET") {
        if (!checkAuth(request)) return jsonResponse({ error: "Unauthorized" }, 401);

        const { results } = await env.DB.prepare(
          "SELECT id, content, created_at FROM notes WHERE is_share = 0 ORDER BY id DESC"
        ).all();

        return jsonResponse(results);
      }

      // 3. 删除笔记 (POST /api/delete)
      if (path === "/api/delete" && request.method === "POST") {
        if (!checkAuth(request)) return jsonResponse({ error: "Unauthorized" }, 401);
        
        const body = await request.json();
        await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(body.id).run();
        
        return jsonResponse({ success: true });
      }

      // 4. AI 总结 (POST /api/ai-sum)
      if (path === "/api/ai-sum" && request.method === "POST") {
        if (!checkAuth(request)) return jsonResponse({ error: "Unauthorized" }, 401);

        const body = await request.json();
        const text = body.text;

        // 调用 Workers AI (使用 Qwen 1.5)
        const aiRes = await env.AI.run('@cf/qwen/qwen1.5-7b-chat-awq', {
          messages: [
            { role: "system", content: "你是一个专业的笔记助手。请用中文简明扼要地总结用户的笔记内容，提取核心要点。" },
            { role: "user", content: text }
          ]
        });

        return jsonResponse({ summary: aiRes.response });
      }

      // 5. 阅后即焚获取 (GET /api/share/:id)
      const shareMatch = path.match(/^\/api\/share\/([a-zA-Z0-9]+)$/);
      if (shareMatch && request.method === "GET") {
        const shareId = shareMatch[1];
        
        const note = await env.DB.prepare(
          "SELECT * FROM notes WHERE public_id = ? AND is_share = 1"
        ).bind(shareId).first();

        if (!note) {
          return jsonResponse({ error: "Not found or expired" }, 404);
        }

        // 读取后立即物理删除
        await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(note.id).run();

        return jsonResponse({ content: note.content });
      }

      // 默认路由
      if (path === "/") {
        return new Response("CloudNotes API is running.", { status: 200, headers: corsHeaders });
      }

      return jsonResponse({ error: "Not Found" }, 404);

    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
};
