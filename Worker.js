export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // --- CORS 配置 (允许跨域) ---
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", // 生产环境建议指定具体域名
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // 处理预检请求 (Browser Preflight)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- 核心修改：支持多 Key 鉴权 ---
    const checkAuth = (req) => {
      const auth = req.headers.get("Authorization");
      if (!auth) return false;

      // 1. 检查单个 Key (兼容旧配置)
      if (env.ADMIN_KEY && auth === env.ADMIN_KEY) {
        return true;
      }

      // 2. 检查多 Key (新配置，逗号分隔)
      // 在 Cloudflare 环境变量中设置 ADMIN_KEYS = "key1,key2,key3"
      if (env.ADMIN_KEYS) {
        // 将配置字符串按逗号、分号或换行符分割，并去除首尾空格
        const validKeys = env.ADMIN_KEYS.split(/[,;\n]+/).map(k => k.trim());
        if (validKeys.includes(auth)) {
          return true;
        }
      }

      return false;
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
