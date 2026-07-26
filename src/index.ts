export interface Env {
	FORMS_DB: D1Database;
	FORMS_KV: KVNamespace;
	API_KEY: string;
	TURNSTILE_SECRET: string;
	EMAIL_FROM: string;
	EMAIL_TO: string;
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
	});
}

function htmlResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
	});
}

function cors(): Response {
	return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key' } });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === 'OPTIONS') return cors();

		const url = new URL(request.url);
		const path = url.pathname;

		if (path === '/') return htmlResponse(LANDING_PAGE);
		if (path === '/dashboard') return htmlResponse(DASHBOARD_PAGE);

		if (path === '/api/forms' && request.method === 'GET') {
			return this.handleListForms(request, env);
		}
		if (path === '/api/forms' && request.method === 'POST') {
			return this.handleCreateForm(request, env);
		}

		const submitMatch = path.match(/^\/api\/forms\/([^/]+)\/submit$/);
		if (submitMatch && request.method === 'POST') {
			return this.handleSubmit(submitMatch[1], request, env);
		}

		const subsMatch = path.match(/^\/api\/forms\/([^/]+)\/submissions$/);
		if (subsMatch && request.method === 'GET') {
			return this.handleListSubmissions(subsMatch[1], request, env);
		}

		const deleteMatch = path.match(/^\/api\/forms\/([^/]+)$/);
		if (deleteMatch && request.method === 'DELETE') {
			return this.handleDeleteForm(deleteMatch[1], request, env);
		}

		return new Response('Not Found', { status: 404 });
	},

	async handleListForms(request: Request, env: Env): Promise<Response> {
		if (!checkAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);
		const { results } = await env.FORMS_DB.prepare('SELECT * FROM forms ORDER BY created_at DESC').all();
		return jsonResponse({ forms: results });
	},

	async handleCreateForm(request: Request, env: Env): Promise<Response> {
		if (!checkAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);
		const body = await request.json() as { name?: string; slug?: string; email_notification?: string; turnstile_enabled?: boolean };
		if (!body.name || !body.slug) return jsonResponse({ error: 'name and slug required' }, 400);
		const id = crypto.randomUUID();
		const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
		await env.FORMS_DB.prepare(
			'INSERT INTO forms (id, name, slug, email_notification, turnstile_enabled) VALUES (?, ?, ?, ?, ?)'
		).bind(id, body.name, slug, body.email_notification || null, body.turnstile_enabled !== false ? 1 : 0).run();
		return jsonResponse({ id, slug, submit_url: `https://formkeeper.successmove000.workers.dev/api/forms/${slug}/submit` }, 201);
	},

	async handleSubmit(slug: string, request: Request, env: Env): Promise<Response> {
		const form = await env.FORMS_DB.prepare('SELECT * FROM forms WHERE slug = ?').bind(slug).first() as any;
		if (!form) return jsonResponse({ error: 'Form not found' }, 404);

		let formData: Record<string, unknown>;
		const ct = request.headers.get('content-type') || '';
		if (ct.includes('application/json')) {
			formData = await request.json() as Record<string, unknown>;
		} else if (ct.includes('form-urlencoded') || ct.includes('multipart/form-data')) {
			const fd = await request.formData();
			formData = Object.fromEntries(fd.entries()) as Record<string, unknown>;
		} else {
			return jsonResponse({ error: 'Unsupported content type' }, 400);
		}

		if (form.turnstile_enabled) {
			const token = formData['cf-turnstile-response'] as string;
			if (!token) return jsonResponse({ error: 'Turnstile token required' }, 400);
			const ip = request.headers.get('CF-Connecting-IP') || '';
			const tres = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
				method: 'POST',
				body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
				headers: { 'Content-Type': 'application/json' },
			});
			const tout = await tres.json() as { success: boolean };
			if (!tout.success) return jsonResponse({ error: 'Turnstile verification failed' }, 403);
			delete formData['cf-turnstile-response'];
		}

		const id = crypto.randomUUID();
		const ip = request.headers.get('CF-Connecting-IP') || '';
		const ua = request.headers.get('User-Agent') || '';
		await env.FORMS_DB.prepare(
			'INSERT INTO submissions (id, form_id, data, ip, ua) VALUES (?, ?, ?, ?, ?)'
		).bind(id, form.id, JSON.stringify(formData), ip, ua).run();

		return jsonResponse({ success: true, id });
	},

	async handleListSubmissions(slug: string, request: Request, env: Env): Promise<Response> {
		if (!checkAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);
		const form = await env.FORMS_DB.prepare('SELECT * FROM forms WHERE slug = ?').bind(slug).first() as any;
		if (!form) return jsonResponse({ error: 'Form not found' }, 404);
		const { results } = await env.FORMS_DB.prepare(
			'SELECT * FROM submissions WHERE form_id = ? ORDER BY created_at DESC LIMIT 100'
		).bind(form.id).all();
		const submissions = results.map((s: any) => ({ ...s, data: JSON.parse(s.data) }));
		return jsonResponse({ form, submissions });
	},

	async handleDeleteForm(slug: string, request: Request, env: Env): Promise<Response> {
		if (!checkAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);
		await env.FORMS_DB.prepare('DELETE FROM submissions WHERE form_id = (SELECT id FROM forms WHERE slug = ?)').bind(slug).run();
		await env.FORMS_DB.prepare('DELETE FROM forms WHERE slug = ?').bind(slug).run();
		return jsonResponse({ success: true });
	},
};

function checkAuth(request: Request, env: Env): boolean {
	const key = request.headers.get('x-api-key');
	return key === env.API_KEY;
}

const LANDING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>FormKeeper</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0f;color:#e0e0e0;line-height:1.6}
.container{max-width:800px;margin:0 auto;padding:2rem}
header{text-align:center;padding:4rem 0 2rem}
h1{font-size:3rem;font-weight:800;background:linear-gradient(135deg,#6366f1,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.subtitle{color:#888;font-size:1.1rem;margin-top:0.5rem}
.features{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:3rem 0}
.feature{background:#13131a;border:1px solid #1e1e2a;border-radius:12px;padding:1.5rem}
.feature h3{color:#a855f7;margin-bottom:0.5rem}
.feature p{color:#888;font-size:0.9rem}
.cta{text-align:center;padding:2rem 0}
.cta a{display:inline-block;background:linear-gradient(135deg,#6366f1,#a855f7);color:white;padding:0.75rem 2rem;border-radius:8px;text-decoration:none;font-weight:600}
code{background:#1a1a2a;padding:0.2rem 0.4rem;border-radius:4px;font-size:0.85rem}
pre{background:#13131a;border:1px solid #1e1e2a;border-radius:8px;padding:1rem;overflow-x:auto;margin:1rem 0;font-size:0.85rem}
</style></head>
<body><div class="container">
<header><h1>FormKeeper</h1><p class="subtitle">Simple form backend — submit, store, and get notified</p></header>
<div class="features">
<div class="feature"><h3>Receive Submissions</h3><p>POST any form data, we store it</p></div>
<div class="feature"><h3>Turnstile Protection</h3><p>Built-in spam protection</p></div>
<div class="feature"><h3>Dashboard</h3><p>View submissions online</p></div>
<div class="feature"><h3>Email Alerts</h3><p>Get notified on each submission</p></div>
</div>
<div class="cta"><a href="/dashboard">Dashboard →</a></div>
<h2>Quick Start</h2>
<pre>curl -X POST https://formkeeper.successmove000.workers.dev/api/forms/YOUR_SLUG/submit \\\\
  -H "Content-Type: application/json" \\\\
  -d '{"name":"John","email":"john@example.com"}'</pre>
</div></body></html>`;

const DASHBOARD_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>FormKeeper Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0f;color:#e0e0e0;line-height:1.6}
.container{max-width:1000px;margin:0 auto;padding:2rem}
h1{font-size:2rem;font-weight:700;background:linear-gradient(135deg,#6366f1,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:2rem}
.card{background:#13131a;border:1px solid #1e1e2a;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem}
.card h3{color:#a855f7}
.meta{color:#666;font-size:0.85rem;margin:0.25rem 0 0.75rem}
.url{background:#0a0a0f;padding:0.5rem;border-radius:6px;font-family:monospace;font-size:0.85rem;word-break:break-all;color:#888}
.actions{display:flex;gap:0.5rem;margin-top:0.75rem}
.actions button{background:#1e1e2a;border:1px solid #2a2a3a;color:#ccc;padding:0.4rem 1rem;border-radius:6px;cursor:pointer;font-size:0.85rem}
.actions .danger{border-color:#ef4444;color:#ef4444}
.sub{background:#0a0a0f;border:1px solid #1a1a2a;border-radius:8px;padding:0.75rem;margin:0.5rem 0}
.sub .time{color:#666;font-size:0.8rem}
.sub table{width:100%;font-size:0.85rem;margin-top:0.5rem}
.sub td{padding:0.2rem 0.5rem;vertical-align:top}
.sub td:first-child{color:#a855f7;font-weight:600;white-space:nowrap}
input{width:100%;background:#1a1a2a;border:1px solid #2a2a3a;color:#e0e0e0;padding:0.6rem;border-radius:6px;margin:0.25rem 0}
.btn{background:linear-gradient(135deg,#6366f1,#a855f7);color:white;border:none;padding:0.5rem 1.5rem;border-radius:8px;cursor:pointer;font-weight:600}
.group{margin:0.5rem 0}
.group label{display:block;font-size:0.85rem;color:#888;margin-bottom:0.25rem}
#auth input{width:300px;display:inline-block}
#auth .btn{display:inline-block;margin-left:0.5rem}
</style></head>
<body><div class="container">
<div class="header"><h1>FormKeeper Dashboard</h1></div>
<div id="auth"><input type="password" id="key" placeholder="API Key" /><button class="btn" onclick="load()">Load</button></div>
<div id="content"></div></div>
<script>
let k='';
async function api(p,o={}){o.headers={...o.headers,'x-api-key':k,'Content-Type':'application/json'};const r=await fetch(p,o);return r.json()}
function showForm(){
  document.getElementById('content').innerHTML='<div class="card"><h2>New Form</h2>'+
    '<div class="group"><label>Name</label><input id="fn"/></div>'+
    '<div class="group"><label>Slug</label><input id="fs"/></div>'+
    '<div class="group"><label>Email (optional)</label><input id="fe" type="email"/></div>'+
    '<div class="group"><label><input id="ft" type="checkbox" checked/> Enable Turnstile</label></div>'+
    '<button class="btn" onclick="create()">Create</button> '+
    '<button onclick="load()" style="background:#1e1e2a;border:1px solid #2a2a3a;color:#ccc;padding:0.5rem 1.5rem;border-radius:8px;cursor:pointer">Cancel</button></div>'
}
async function create(){
  const r=await api('/api/forms',{method:'POST',body:JSON.stringify({
    name:document.getElementById('fn').value,
    slug:document.getElementById('fs').value,
    email_notification:document.getElementById('fe').value,
    turnstile_enabled:document.getElementById('ft').checked
  })});
  if(r.error) return alert(r.error); load()
}
async function del(slug){if(!confirm('Delete?')) return;await api('/api/forms/'+slug,{method:'DELETE'});load()}
async function subs(slug){
  const d=await api('/api/forms/'+slug+'/submissions');
  let h='<div class="card"><h3>'+d.form.name+'</h3><div class="meta">Created: '+d.form.created_at+'</div></div>';
  h+='<h3 style="margin-bottom:0.5rem">Submissions ('+d.submissions.length+')</h3>';
  if(!d.submissions.length) h+='<p style="color:#666">None yet.</p>';
  for(const s of d.submissions){
    const f=Object.entries(s.data).map(([k,v])=>'<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('');
    h+='<div class="sub"><div class="time">'+s.created_at+' · IP: '+(s.ip||'-')+'</div><table>'+f+'</table></div>'
  }
  h+='<br/><button onclick="load()" style="background:#1e1e2a;border:1px solid #2a2a3a;color:#ccc;padding:0.5rem 1.5rem;border-radius:8px;cursor:pointer">← Back</button>';
  document.getElementById('content').innerHTML=h
}
async function load(){
  k=document.getElementById('key').value;if(!k) return alert('Enter key');
  const d=await api('/api/forms');
  if(d.error) return alert(d.error);
  let h='<div style="margin-bottom:1rem"><button class="btn" onclick="showForm()">+ New Form</button></div>';
  for(const f of d.forms){
    h+='<div class="card"><h3>'+f.name+'</h3><div class="meta">Slug: '+f.slug+' · Created: '+f.created_at+'</div>'+
      '<div class="url">'+window.location.origin+'/api/forms/'+f.slug+'/submit</div>'+
      '<div class="actions"><button onclick="subs(\\''+f.slug+'\\')">View</button>'+
      '<button class="danger" onclick="del(\\''+f.slug+'\\')">Delete</button></div></div>'
  }
  document.getElementById('content').innerHTML=h
}
</script></body></html>`;
