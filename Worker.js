export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", 
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // --- 核心鉴权逻辑 ---
    const checkAuth = (req) => {
      const auth = req.headers.get("Authorization");
      
      // 读取变量
      const key1 = env.ADMIN_KEY || "";
      const key2 = env.ADMIN_KEYS || "";

      // 处理白名单
      const allKeys = (key1 + "," + key2)
        .replace(/，/g, ',')
        .split(',')
        .map(k => k.trim())
        .filter(k => k !== "");

      // 验证
      const received = auth ? auth.trim() : "";
      const isPass = allKeys.includes(received);

      return { 
        pass: isPass, 
        // 调试信息：把收到的 Key 和白名单都返回去
        debugInfo: `前端发来: [${received}], 后端白名单: [${allKeys.join(', ')}]` 
      };
    };

    const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

    try {
      const url = new URL(request.url);
      
      // API: 保存
      if (url.pathname === "/api/save" && request.method === "POST") {
        const check = checkAuth(request);
        if (!check.pass) {
          // 把 debugInfo 放入 details
          return jsonResponse({ error: "暗号错误", details: check.debugInfo }, 401);
        }
        
        const body = await request.json();
        await env.DB.prepare("INSERT INTO notes (content, is_share, public_id) VALUES (?, ?, ?)").bind(body.content, body.is_share ? 1 : 0, body.public_id || null).run();
        return jsonResponse({ success: true });
      }

      // API: 列表
      if (url.pathname === "/api/list" && request.method === "GET") {
        const check = checkAuth(request);
        if (!check.pass) return jsonResponse({ error: "暗号错误", details: check.debugInfo }, 401);
        const { results } = await env.DB.prepare("SELECT id, content, created_at FROM notes WHERE is_share = 0 ORDER BY id DESC").all();
        return jsonResponse(results);
      }

      // API: 删除
      if (url.pathname === "/api/delete" && request.method === "POST") {
        const check = checkAuth(request);
        if (!check.pass) return jsonResponse({ error: "暗号错误", details: check.debugInfo }, 401);
        const body = await request.json();
        await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(body.id).run();
        return jsonResponse({ success: true });
      }

      return new Response("API Running", { status: 200, headers: corsHeaders });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
};
