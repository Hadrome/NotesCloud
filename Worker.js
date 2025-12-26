export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // --- CORS 配置 ---
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", 
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- 响应辅助函数 ---
    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status: status,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    };

    // --- 【关键修改】带诊断功能的鉴权函数 ---
    const checkAuthAndGetReason = (req) => {
      const auth = req.headers.get("Authorization");
      
      // 1. 读取环境变量 (如果读取不到，显示为 NULL)
      const valKey1 = env.ADMIN_KEY || "NULL";
      const valKey2 = env.ADMIN_KEYS || "NULL";

      // 2. 构造白名单
      // 即使变量没读到，也尝试处理，防止报错
      const safeString = (valKey1 !== "NULL" ? valKey1 : "") + "," + (valKey2 !== "NULL" ? valKey2 : "");
      
      const allowedKeys = safeString
        .replace(/，/g, ',')      // 中文逗号转英文
        .split(',')               // 分割
        .map(k => k.trim())       // 去空格
        .filter(k => k !== "");   // 去空项

      // 3. 检查匹配
      const received = auth ? auth.trim() : "无(空)";
      const isPass = allowedKeys.includes(received);

      // 4. 如果失败，返回详细的调试文本
      // 注意：为了安全，测试完请务必删除这段代码，否则会泄露您的 Key！
      if (!isPass) {
        return {
          pass: false,
          // 这段文字会直接显示在前端弹窗里
          errorMsg: `鉴权失败！\n前端发送: [${received}]\n后台 ADMIN_KEY: [${valKey1}]\n后台 ADMIN_KEYS: [${valKey2}]\n后台有效白名单: [${allowedKeys.join(' / ')}]`
        };
      }

      return { pass: true };
    };

    try {
      // 1. 保存接口
      if (path === "/api/save" && request.method === "POST") {
        const check = checkAuthAndGetReason(request);
        if (!check.pass) {
          // 将调试信息放入 error 字段，前端会自动弹窗显示
          return jsonResponse({ error: check.errorMsg }, 401);
        }
        
        const body = await request.json();
        const isShare = body.is_share ? 1 : 0;
        await env.DB.prepare(
          "INSERT INTO notes (content, is_share, public_id) VALUES (?, ?, ?)"
        ).bind(body.content, isShare, body.public_id || null).run();

        return jsonResponse({ success: true });
      }

      // 2. 列表接口
      if (path === "/api/list" && request.method === "GET") {
        const check = checkAuthAndGetReason(request);
        if (!check.pass) return jsonResponse({ error: check.errorMsg }, 401);

        const { results } = await env.DB.prepare(
          "SELECT id, content, created_at FROM notes WHERE is_share = 0 ORDER BY id DESC"
        ).all();

        return jsonResponse(results);
      }

      // 3. 删除接口
      if (path === "/api/delete" && request.method === "POST") {
        const check = checkAuthAndGetReason(request);
        if (!check.pass) return jsonResponse({ error: check.errorMsg }, 401);
        
        const body = await request.json();
        await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(body.id).run();
        
        return jsonResponse({ success: true });
      }

      // 4. AI 接口
      if (path === "/api/ai-sum" && request.method === "POST") {
        const check = checkAuthAndGetReason(request);
        if (!check.pass) return jsonResponse({ error: check.errorMsg }, 401);

        const body = await request.json();
        if (!env.AI) return jsonResponse({ summary: "未配置 AI" });
        const aiRes = await env.AI.run('@cf/qwen/qwen1.5-7b-chat-awq', { messages: [{ role: "system", content: "总结" }, { role: "user", content: body.text }] });
        return jsonResponse({ summary: aiRes.response });
      }

      // 5. 阅后即焚接口 (不需要鉴权)
      if (path.startsWith("/api/share/")) {
         // ... (保持原有逻辑，此处略以节省长度) ...
         // 如果您需要这段逻辑，请保留原代码中的这部分，或者仅仅替换上面的鉴权接口部分
         // 简写版：
         const shareId = path.split('/').pop();
         const note = await env.DB.prepare("SELECT * FROM notes WHERE public_id = ?").bind(shareId).first();
         if(note) {
             await env.DB.prepare("DELETE FROM notes WHERE id=?").bind(note.id).run();
             return jsonResponse({content: note.content});
         }
         return jsonResponse({error: "NotFound"}, 404);
      }

      return new Response("API Running", { headers: corsHeaders });

    } catch (e) {
      return jsonResponse({ error: "System Error: " + e.message }, 500);
    }
  }
};
