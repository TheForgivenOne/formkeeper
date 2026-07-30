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
		
		const statsMatch = path.match(/^\/api\/forms\/([^/]+)\/stats$/);
		if (statsMatch && request.method === 'GET') {
			return this.handleFormStats(statsMatch[1], request, env);
		}

		const deleteMatch = path.match(/^\/api\/forms\/([^/]+)$/);
		if (deleteMatch && request.method === 'DELETE') {
			return this.handleDeleteForm(deleteMatch[1], request, env);
		}

		return new Response('Not Found', { status: 404 });
	},

	async handleFormStats(slug: string, request: Request, env: Env): Promise<Response> {
		if (!checkAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);
		const form = await env.FORMS_DB.prepare('SELECT * FROM forms WHERE slug = ?').bind(slug).first() as any;
		if (!form) return jsonResponse({ error: 'Form not found' }, 404);
		const { results } = await env.FORMS_DB.prepare(
			'SELECT data, ip, ua, created_at FROM submissions WHERE form_id = ? ORDER BY created_at DESC LIMIT 100'
		).bind(form.id).all();
		const submissions = results.map((s: any) => ({ ...s, data: JSON.parse(s.data) }));
		const today = new Date().toISOString().split('T')[0];
		const todayCount = submissions.filter((s: any) => s.created_at.startsWith(today)).length;
		return jsonResponse({
			form: { ...form, submission_count: results.length, today_count: todayCount },
			submissions,
		});
	},

	async handleListForms(request: Request, env: Env): Promise<Response> {
		if (!checkAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);
		const { results } = await env.FORMS_DB.prepare('SELECT * FROM forms ORDER BY created_at DESC').all();
		const formsWithCounts = await Promise.all(results.map(async (f: any) => {
			const { results: subs } = await env.FORMS_DB.prepare(
				'SELECT created_at FROM submissions WHERE form_id = ?'
			).bind(f.id).all();
			const today = new Date().toISOString().split('T')[0];
			return {
				...f,
				submission_count: subs.length,
				today_count: subs.filter((s: any) => s.created_at.startsWith(today)).length,
			};
		}));
		return jsonResponse({ forms: formsWithCounts });
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

const CSS = `*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0f;color:#e4e4e7;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.container{max-width:1040px;margin:0 auto;padding:0 24px}
section{padding:80px 0}
section + section{border-top:1px solid #16161f}

/* nav */
nav{display:flex;align-items:center;justify-content:space-between;padding:20px 0}
nav .logo{font-size:1.25rem;font-weight:600;color:#e4e4e7;letter-spacing:-0.02em}
nav .logo em{font-style:normal;color:#3b82f6}
nav .links{display:flex;gap:24px;align-items:center}
nav .links a{font-size:0.875rem;color:#8b8b93;transition:color .2s}
nav .links a:hover{color:#e4e4e7}
nav .links .btn{background:#3b82f6;color:#fff!important;padding:8px 16px;border-radius:6px;font-weight:500;font-size:0.8125rem}

/* hero */
.hero{text-align:center;padding:120px 0 80px}
.hero .badge{display:inline-block;font-size:0.75rem;font-weight:500;color:#3b82f6;background:#1a1a2e;border:1px solid rgba(59,130,246,.2);padding:4px 12px;border-radius:20px;margin-bottom:24px;letter-spacing:0.02em}
.hero h1{font-size:3.5rem;font-weight:600;letter-spacing:-0.03em;line-height:1.15;margin-bottom:16px;color:#fafafa}
.hero h1 em{font-style:normal;color:#3b82f6}
.hero p{font-size:1.125rem;color:#8b8b93;max-width:560px;margin:0 auto 32px}
.hero .actions{display:flex;gap:12px;justify-content:center}
.hero .actions .primary{background:#3b82f6;color:#fff;padding:12px 24px;border-radius:8px;font-weight:500;font-size:0.9375rem;transition:background .2s}
.hero .actions .primary:hover{background:#2563eb}
.hero .actions .secondary{color:#8b8b93;padding:12px 24px;border-radius:8px;font-size:0.9375rem;border:1px solid #1e1e28;transition:border .2s,color .2s}
.hero .actions .secondary:hover{border-color:#3b82f6;color:#e4e4e7}

/* dashboard preview */
.dash-preview{margin-top:64px;border-radius:12px;overflow:hidden;border:1px solid #16161f;background:#0e0e14;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.dash-preview .bar{display:flex;align-items:center;gap:8px;padding:12px 16px;background:#12121a;border-bottom:1px solid #1e1e28}
.dash-preview .bar .dot{width:10px;height:10px;border-radius:50%}
.dash-preview .bar .dot.r{background:#ef4444}
.dash-preview .bar .dot.y{background:#eab308}
.dash-preview .bar .dot.g{background:#22c55e}
.dash-preview .bar span{color:#555;font-size:0.75rem;margin-left:8px}
.dash-preview .body{display:grid;grid-template-columns:200px 1fr;min-height:300px}
.dash-preview .sidebar{padding:16px;background:#0a0a0f;border-right:1px solid #16161f}
.dash-preview .sidebar .item{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;font-size:0.8125rem;color:#6b6b76;margin-bottom:4px}
.dash-preview .sidebar .item.active{background:#16161f;color:#e4e4e7}
.dash-preview .sidebar .item svg{width:14px;height:14px;flex-shrink:0}
.dash-preview .main{padding:24px}
.dash-preview .main .row{display:flex;gap:12px;margin-bottom:16px}
.dash-preview .main .stat{flex:1;background:#12121a;border:1px solid #1e1e28;border-radius:8px;padding:16px}
.dash-preview .main .stat .num{font-size:1.5rem;font-weight:600;color:#fafafa}
.dash-preview .main .stat .lbl{font-size:0.75rem;color:#6b6b76;margin-top:2px}
.dash-preview .main table{width:100%;border-collapse:collapse;font-size:0.8125rem}
.dash-preview .main th{text-align:left;padding:8px 12px;color:#6b6b76;font-weight:500;border-bottom:1px solid #1e1e28}
.dash-preview .main td{padding:8px 12px;color:#a1a1aa;border-bottom:1px solid #16161f}
.dash-preview .main td:first-child{color:#e4e4e7}

/* sections */
.section-label{font-size:0.75rem;font-weight:600;color:#3b82f6;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px}
.section-title{font-size:2rem;font-weight:600;letter-spacing:-0.02em;margin-bottom:12px;color:#fafafa}
.section-sub{color:#8b8b93;font-size:0.9375rem;max-width:480px;margin-bottom:48px}

/* steps */
.steps{display:grid;grid-template-columns:1fr 1fr 1fr;gap:32px}
.step{padding:24px;border-radius:10px;background:#0e0e14;border:1px solid #16161f}
.step .num{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:#1a1a2e;color:#3b82f6;font-size:0.8125rem;font-weight:600;margin-bottom:16px}
.step h3{font-size:1rem;font-weight:600;margin-bottom:6px;color:#e4e4e7}
.step p{font-size:0.875rem;color:#6b6b76;line-height:1.6}

/* features */
.features-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px}
.feature-card{padding:24px;border-radius:10px;background:#0e0e14;border:1px solid #16161f}
.feature-card .icon{width:36px;height:36px;border-radius:8px;background:#1a1a2e;display:flex;align-items:center;justify-content:center;margin-bottom:12px;color:#3b82f6}
.feature-card h3{font-size:0.9375rem;font-weight:600;margin-bottom:4px;color:#e4e4e7}
.feature-card p{font-size:0.8125rem;color:#6b6b76;line-height:1.6}

/* code */
.code-block{background:#0e0e14;border:1px solid #16161f;border-radius:10px;overflow:hidden}
.code-block .bar{display:flex;align-items:center;gap:8px;padding:12px 16px;background:#12121a;border-bottom:1px solid #1e1e28;font-size:0.75rem;color:#555}
.code-block .bar .dot{width:8px;height:8px;border-radius:50%}
.code-block pre{padding:20px;overflow-x:auto;font-family:'SF Mono',Monaco,'Cascadia Code','Consolas',monospace;font-size:0.8125rem;line-height:1.7;color:#a1a1aa}
.code-block pre .hl{color:#3b82f6}
.code-block pre .cm{color:#555}
.code-block pre .str{color:#22c55e}
.code-block pre .tag{color:#f472b6}

/* pricing */
.pricing-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:680px}
.plan-card{padding:32px;border-radius:10px;background:#0e0e14;border:1px solid #16161f}
.plan-card.featured{border-color:#3b82f6;position:relative}
.plan-card.featured:before{content:'Popular';position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:#3b82f6;color:#fff;font-size:0.6875rem;font-weight:600;padding:2px 12px;border-radius:10px;text-transform:uppercase;letter-spacing:0.05em}
.plan-card .name{font-size:1rem;font-weight:600;color:#e4e4e7;margin-bottom:4px}
.plan-card .desc{font-size:0.8125rem;color:#6b6b76;margin-bottom:20px}
.plan-card .price{font-size:2.5rem;font-weight:600;color:#fafafa;letter-spacing:-0.03em;margin-bottom:4px}
.plan-card .price span{font-size:1rem;color:#6b6b76;font-weight:400}
.plan-card .sub-desc{font-size:0.75rem;color:#6b6b76;margin-bottom:20px}
.plan-card .features-list{list-style:none;margin-bottom:24px}
.plan-card .features-list li{padding:6px 0;font-size:0.875rem;color:#a1a1aa;display:flex;align-items:center;gap:8px}
.plan-card .features-list li:before{content:'';width:16px;height:16px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border-radius:50%;background:#1a1a2e;color:#3b82f6;font-size:0.625rem}
.plan-card .features-list .check:before{content:'\\2713'}
.plan-card .cta-btn{display:block;text-align:center;padding:10px;border-radius:6px;font-size:0.875rem;font-weight:500}
.plan-card .cta-btn.primary{background:#3b82f6;color:#fff;transition:background .2s}
.plan-card .cta-btn.primary:hover{background:#2563eb}
.plan-card .cta-btn.secondary{background:#16161f;border:1px solid #1e1e28;color:#a1a1aa;transition:border .2s,color .2s}
.plan-card .cta-btn.secondary:hover{border-color:#3b82f6;color:#e4e4e7}

/* faq */
.faq-list{max-width:640px}
.faq-item{padding:20px 0;border-bottom:1px solid #16161f}
.faq-item:last-child{border:0}
.faq-item h3{font-size:0.9375rem;font-weight:600;margin-bottom:6px;color:#e4e4e7}
.faq-item p{font-size:0.875rem;color:#6b6b76;line-height:1.6}

/* footer */
footer{padding:40px 0;border-top:1px solid #16161f;display:flex;justify-content:space-between;align-items:center;font-size:0.8125rem;color:#555}
footer a{color:#6b6b76;transition:color .2s}
footer a:hover{color:#e4e4e7}

@media (max-width:768px){
  .hero h1{font-size:2rem}
  .steps,.features-grid{grid-template-columns:1fr}
  .pricing-grid{grid-template-columns:1fr}
  .dash-preview .body{grid-template-columns:1fr}
  section{padding:48px 0}
  .hero{padding:80px 0 48px}
  nav .links a{display:none}
  nav .links .btn{display:block}
}
`

const DASHBOARD_CSS = `*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0f;color:#e4e4e7;-webkit-font-smoothing:antialiased;min-height:100vh}
/* auth */
#auth{display:flex;align-items:center;justify-content:center;min-height:80vh}
#auth .box{background:#0e0e14;border:1px solid #16161f;border-radius:12px;padding:40px;width:380px}
#auth .box h1{font-size:1.5rem;font-weight:600;margin-bottom:4px;letter-spacing:-0.02em}
#auth .box h1 em{font-style:normal;color:#3b82f6}
#auth .box p{font-size:0.875rem;color:#6b6b76;margin-bottom:24px}
#auth .box label{display:block;font-size:0.8125rem;color:#8b8b93;margin-bottom:6px;font-weight:500}
#auth .box input{width:100%;background:#12121a;border:1px solid #1e1e28;color:#e4e4e7;padding:10px 14px;border-radius:6px;font-size:0.875rem;outline:none;transition:border .2s}
#auth .box input:focus{border-color:#3b82f6}
#auth .box .btn{width:100%;margin-top:16px;background:#3b82f6;color:#fff;border:none;padding:10px;border-radius:6px;font-size:0.875rem;font-weight:500;cursor:pointer;transition:background .2s}
#auth .box .btn:hover{background:#2563eb}
#auth .box .error{color:#ef4444;font-size:0.8125rem;margin-top:12px;display:none}
/* dashboard layout */
.dash{display:none;min-height:100vh}
.dash .side{width:220px;background:#0e0e14;border-right:1px solid #16161f;padding:20px;display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0}
.dash .side .logo{font-size:1rem;font-weight:600;margin-bottom:24px;letter-spacing:-0.02em}
.dash .side .logo em{font-style:normal;color:#3b82f6}
.dash .side .nav-item{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;font-size:0.8125rem;color:#6b6b76;margin-bottom:2px;cursor:pointer;transition:all .2s}
.dash .side .nav-item:hover{color:#e4e4e7;background:#16161f}
.dash .side .nav-item.active{color:#e4e4e7;background:#16161f}
.dash .side .nav-item svg{width:16px;height:16px;flex-shrink:0}
.dash .side .spacer{flex:1}
.dash .side .logout{font-size:0.75rem;color:#555;cursor:pointer;padding:8px 12px;border-radius:6px;transition:color .2s}
.dash .side .logout:hover{color:#ef4444}
.dash .main{margin-left:220px;flex:1;padding:32px 40px}
.dash .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:32px}
.dash .top h2{font-size:1.5rem;font-weight:600;letter-spacing:-0.02em}
.dash .top .btn{background:#3b82f6;color:#fff;border:none;padding:8px 18px;border-radius:6px;font-size:0.8125rem;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:6px;transition:background .2s}
.dash .top .btn:hover{background:#2563eb}
/* stats row */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:32px}
.stat-card{background:#0e0e14;border:1px solid #16161f;border-radius:10px;padding:20px}
.stat-card .num{font-size:1.75rem;font-weight:600;color:#fafafa;letter-spacing:-0.02em}
.stat-card .lbl{font-size:0.75rem;color:#6b6b76;margin-top:2px}
/* form list */
.form-card{background:#0e0e14;border:1px solid #16161f;border-radius:10px;padding:20px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;transition:border .2s}
.form-card:hover{border-color:#1e1e28}
.form-card .info h3{font-size:0.9375rem;font-weight:600;color:#e4e4e7}
.form-card .info .meta{font-size:0.75rem;color:#6b6b76;margin-top:2px}
.form-card .info .url{font-size:0.75rem;color:#3b82f6;font-family:'SF Mono',monospace;margin-top:4px}
.form-card .actions{display:flex;gap:8px}
.form-card .actions button{padding:6px 14px;border-radius:6px;font-size:0.75rem;border:none;cursor:pointer;font-weight:500;transition:all .2s}
.form-card .actions .view{background:#16161f;color:#a1a1aa;border:1px solid #1e1e28}
.form-card .actions .view:hover{color:#e4e4e7;border-color:#3b82f6}
.form-card .actions .del{background:#1a1111;color:#ef4444;border:1px solid #2a1515}
.form-card .actions .del:hover{background:#2a1515}
.form-badge{display:inline-block;font-size:0.625rem;font-weight:500;padding:2px 8px;border-radius:10px;background:#1a1a2e;color:#3b82f6;margin-left:8px}

/* modal overlay */
.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:100;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal{background:#0e0e14;border:1px solid #1e1e28;border-radius:12px;padding:32px;width:440px;max-width:90vw}
.modal h2{font-size:1.125rem;font-weight:600;margin-bottom:4px}
.modal .sub{font-size:0.8125rem;color:#6b6b76;margin-bottom:20px}
.modal label{display:block;font-size:0.8125rem;color:#8b8b93;margin-bottom:4px;font-weight:500}
.modal input[type="text"],.modal input[type="email"]{width:100%;background:#12121a;border:1px solid #1e1e28;color:#e4e4e7;padding:10px 14px;border-radius:6px;font-size:0.875rem;outline:none;margin-bottom:16px;transition:border .2s}
.modal input:focus{border-color:#3b82f6}
.modal .row{display:flex;gap:12px}
.modal .row > div{flex:1}
.modal .btns{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
.modal .btns button{padding:8px 20px;border-radius:6px;font-size:0.8125rem;font-weight:500;cursor:pointer;transition:all .2s}
.modal .btns .primary{background:#3b82f6;color:#fff;border:none}
.modal .btns .primary:hover{background:#2563eb}
.modal .btns .cancel{background:transparent;color:#6b6b76;border:1px solid #1e1e28}
.modal .btns .cancel:hover{color:#e4e4e7}
/* submissions view */
.subs-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
.subs-header h2{font-size:1.25rem;font-weight:600}
.subs-header .back{color:#6b6b76;cursor:pointer;font-size:0.8125rem;display:flex;align-items:center;gap:4px;transition:color .2s}
.subs-header .back:hover{color:#e4e4e7}
.sub-table{width:100%;border-collapse:collapse;font-size:0.8125rem}
.sub-table th{text-align:left;padding:10px 14px;color:#6b6b76;font-weight:500;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.03em;border-bottom:1px solid #1e1e28}
.sub-table td{padding:10px 14px;color:#a1a1aa;border-bottom:1px solid #16161f;vertical-align:top}
.sub-table td:first-child{color:#e4e4e7}
.sub-table tr:hover td{background:#0e0e14}
.sub-table .empty{text-align:center;padding:40px;color:#555;font-size:0.875rem}
.sub-detail{background:#0e0e14;border:1px solid #16161f;border-radius:10px;padding:24px;margin-bottom:16px}
.sub-detail .time{font-size:0.75rem;color:#6b6b76;margin-bottom:12px;display:flex;gap:16px}
.sub-detail .fields{display:grid;grid-template-columns:120px 1fr;gap:8px 16px;font-size:0.8125rem}
.sub-detail .fields .key{color:#6b6b76;font-weight:500}
.sub-detail .fields .val{color:#e4e4e7;word-break:break-word}
@media (max-width:768px){
  .dash .side{display:none}
  .dash .main{margin-left:0;padding:20px}
  .stats{grid-template-columns:1fr}
  .form-card{flex-direction:column;align-items:flex-start;gap:12px}
}
`

const LANDING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>FormKeeper — self-hosted form backend for Cloudflare</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>

<div class="container">
<nav>
<div class="logo"><em>Form</em>Keeper</div>
<div class="links">
<a href="#how">How it works</a>
<a href="#features">Features</a>
<a href="#pricing">Pricing</a>
<a href="https://github.com/TheForgivenOne/formkeeper">GitHub</a>
<a href="/dashboard" class="btn">Dashboard</a>
</div>
</nav>
</div>

<section class="hero">
<div class="container">
<div class="badge">Open source &bull; Cloudflare Workers</div>
<h1>Your forms deserve<br>a <em>proper</em> backend.</h1>
<p>Deploy a form backend on your own Cloudflare account in 2 minutes. Free, open source, no vendor lock-in. Turnstile spam protection built in.</p>
<div class="actions">
<a href="https://github.com/TheForgivenOne/formkeeper" class="primary">Deploy on Cloudflare</a>
<a href="/dashboard" class="secondary">Live demo &rarr;</a>
</div>
</div>

<div class="container">
<div class="dash-preview">
<div class="bar">
<div class="dot r"></div><div class="dot y"></div><div class="dot g"></div>
<span>formkeeper.successmove000.workers.dev/dashboard</span>
</div>
<div class="body">
<div class="sidebar">
<div class="item active"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M2 6h12"/></svg>Forms</div>
<div class="item"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></svg>Activity</div>
<div class="item"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 12l4-4 3 3 5-5"/></svg>Analytics</div>
<div class="item"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2"/></svg>Settings</div>
</div>
<div class="main">
<div class="row">
<div class="stat"><div class="num" id="pv-forms">0</div><div class="lbl">Total forms</div></div>
<div class="stat"><div class="num" id="pv-today">0</div><div class="lbl">Submissions today</div></div>
<div class="stat"><div class="num" id="pv-total">0</div><div class="lbl">All submissions</div></div>
</div>
<table>
<tr><th>Form</th><th>Slug</th><th>Submissions</th><th>Created</th></tr>
<tr><td style="color:#e4e4e7">Contact</td><td>contact</td><td>12</td><td>2 days ago</td></tr>
<tr><td style="color:#e4e4e7">Waitlist</td><td>waitlist</td><td>47</td><td>1 week ago</td></tr>
<tr><td style="color:#e4e4e7">Newsletter</td><td>newsletter</td><td>8</td><td>3 weeks ago</td></tr>
</table>
</div>
</div>
</div>
</div>
</section>

<section id="how">
<div class="container">
<div class="section-label">How it works</div>
<h2 class="section-title">Three steps to a working form.</h2>
<p class="section-sub">No server code to write. No monthly fees. Just your Cloudflare account and two clicks.</p>
<div class="steps">
<div class="step">
<div class="num">1</div>
<h3>Deploy to Cloudflare</h3>
<p>Click the Deploy button, connect your Cloudflare account, and the Worker goes live instantly. D1 database and KV namespace are provisioned automatically.</p>
</div>
<div class="step">
<div class="num">2</div>
<h3>Create a form from the dashboard</h3>
<p>Give it a name and a slug. Enable Turnstile for spam protection. Copy the endpoint URL — it looks like <code style="font-size:0.75rem;background:#1a1a2e;padding:1px 4px;border-radius:3px">forms.example.com/api/forms/contact/submit</code>.</p>
</div>
<div class="step">
<div class="num">3</div>
<h3>Point your HTML form at the endpoint</h3>
<p>Set the endpoint as your form's <code>action</code> URL. Submissions land in your dashboard with IP, user agent, and a timestamp. Email notifications included.</p>
</div>
</div>
</div>
</section>

<section id="features">
<div class="container">
<div class="section-label">Features</div>
<h2 class="section-title">Everything you need, nothing you don't.</h2>
<p class="section-sub">Purpose-built for static sites and Jamstack projects. Works with any HTML form.</p>
<div class="features-grid">
<div class="feature-card">
<div class="icon"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 14l4-4 3 3 7-7"/></svg></div>
<h3>Turnstile spam protection</h3>
<p>Cloudflare Turnstile blocks bots without CAPTCHAs. Free, privacy-friendly, one checkbox to enable.</p>
</div>
<div class="feature-card">
<div class="icon"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="3" width="15" height="12" rx="2"/><path d="M1.5 7h15"/></svg></div>
<h3>Beautiful dashboard</h3>
<p>View submissions, inspect data, and manage forms from a clean, dark-themed admin interface.</p>
</div>
<div class="feature-card">
<div class="icon"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 1v16M1 9h16"/></svg></div>
<h3>D1 database storage</h3>
<p>Every submission stored in Cloudflare D1 with IP, user agent, and a timestamp. Full SQL query access if you want it.</p>
</div>
<div class="feature-card">
<div class="icon"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3h12v12H3z"/><path d="M6 7v4M9 6v5M12 8v3"/></svg></div>
<h3>Email notifications</h3>
<p>Get notified when a submission arrives. Configure per-form — different emails for contact forms vs waitlist signups.</p>
</div>
<div class="feature-card">
<div class="icon"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 2l-5 5 5 5M11 2l5 5-5 5"/></svg></div>
<h3>JSON &amp; form-data</h3>
<p>Submit as JSON or standard HTML form encoding. Works with any framework, any static host.</p>
</div>
<div class="feature-card">
<div class="icon"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="9" r="7"/><path d="M9 5v4l3 2"/></svg></div>
<h3>Open source</h3>
<p>Full source on GitHub. MIT licensed. No hidden tracking, no data mining, no vendor lock-in.</p>
</div>
</div>
</div>
</section>

<section id="code">
<div class="container">
<div class="section-label">Quick start</div>
<h2 class="section-title">One curl command.</h2>
<p class="section-sub">Create a form, then submit data. That's the whole integration.</p>
<div class="code-block">
<div class="bar"><div class="dot r"></div><div class="dot y"></div><div class="dot g"></div>Terminal</div>
<pre><span class="cm"># Create a form</span>
curl -X POST https://formkeeper.successmove000.workers.dev/api/forms \
  -H <span class="str">"Content-Type: application/json"</span> \
  -H <span class="str">"x-api-key: your-api-key"</span> \
  -d <span class="str">'{"name":"Contact","slug":"contact","turnstile_enabled":true}'</span>

<span class="cm"># Submit to the form</span>
curl -X POST https://formkeeper.successmove000.workers.dev/api/forms/contact/submit \
  -H <span class="str">"Content-Type: application/json"</span> \
  -d <span class="str">'{"name":"Jane","email":"jane@example.com","message":"Hello!"}'</span>

<span class="cm"># View submissions (from dashboard)</span>
curl https://formkeeper.successmove000.workers.dev/api/forms/contact/submissions \
  -H <span class="str">"x-api-key: your-api-key"</span></pre>
</div>
</div>
</section>

<section id="pricing">
<div class="container">
<div class="section-label">Pricing</div>
<h2 class="section-title">Free to self-host. <em style="font-style:normal;color:#3b82f6">$20</em> if you want it done.</h2>
<p class="section-sub">The code is free and open source. Pay only if you want me to deploy and configure it on your Cloudflare account.</p>
<div class="pricing-grid">
<div class="plan-card">
<div class="name">Self-hosted</div>
<div class="desc">Deploy on your own Cloudflare account. Full control, no ongoing costs.</div>
<div class="price">$0</div>
<div class="sub-desc">Free forever &middot; MIT license</div>
<ul class="features-list">
<li class="check">Deploy via Cloudflare dashboard button</li>
<li class="check">D1 database + KV storage</li>
<li class="check">Turnstile spam protection</li>
<li class="check">Email notifications</li>
<li class="check">Beautiful admin dashboard</li>
</ul>
<a href="https://github.com/TheForgivenOne/formkeeper" class="cta-btn secondary">Deploy on Cloudflare</a>
</div>
<div class="plan-card featured">
<div class="name">Setup Service</div>
<div class="desc">I deploy FormKeeper on your Cloudflare account with your custom domain.</div>
<div class="price">$20 <span>one-time</span></div>
<div class="sub-desc">No subscription &middot; No hidden fees</div>
<ul class="features-list">
<li class="check">Deployed on your Cloudflare account</li>
<li class="check">Custom domain configured</li>
<li class="check">Turnstile + email set up</li>
<li class="check">30 minute turnaround</li>
<li class="check">Lifetime access to source</li>
</ul>
<a href="mailto:successmove000@gmail.com?subject=FormKeeper%20Setup" class="cta-btn primary">Email to order</a>
</div>
</div>
</div>
</section>

<section id="faq">
<div class="container">
<div class="section-label">FAQ</div>
<h2 class="section-title">Common questions.</h2>
<div class="faq-list">
<div class="faq-item">
<h3>How is this different from Formspree or FormKeep?</h3>
<p>FormKeeper is self-hosted — it runs on your Cloudflare account. Your data stays in your database. No monthly subscription, no per-submission fees. Just Cloudflare's free tier (or usage-based pricing if you exceed it).</p>
</div>
<div class="faq-item">
<h3>Do I need a paid Cloudflare plan?</h3>
<p>No. Cloudflare Workers has a generous free tier (100k requests/day). D1 and Turnstile also have free tiers. Most sites never exceed the free limits.</p>
</div>
<div class="faq-item">
<h3>Can I use my own domain?</h3>
<p>Yes. If you purchase the $20 setup service, I'll configure a custom domain for you. Self-hosted users can add a custom route in their Cloudflare dashboard.</p>
</div>
<div class="faq-item">
<h3>Does it work with any form?</h3>
<p>Any HTML form that submits via POST. JSON, URL-encoded, or multipart form data. Works with plain HTML &lt;form&gt; tags, React, Vue, Astro — anything that can make an HTTP request.</p>
</div>
<div class="faq-item">
<h3>How do I get support?</h3>
<p>Open an issue on GitHub for bugs or feature requests. For the $20 setup service, email support is included.</p>
</div>
</div>
</div>
</section>

<div class="container">
<footer>
<span>&copy; 2026 FormKeeper &mdash; MIT license</span>
<a href="https://github.com/TheForgivenOne/formkeeper">GitHub</a>
</footer>
</div>

<script>
fetch('/api/forms/stats').then(r=>r.json()).then(d=>{
  if(!d.error&&d.form){
    document.getElementById('pv-forms').textContent=d.form.submission_count||'—';
    document.getElementById('pv-today').textContent='—';
    document.getElementById('pv-total').textContent='—';
  }
}).catch(()=>{});
</script>

</body>
</html>`

const DASHBOARD_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>FormKeeper Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${DASHBOARD_CSS}</style>
</head>
<body>

<div id="auth">
<div class="box">
<h1><em>Form</em>Keeper</h1>
<p>Enter your API key to access the dashboard.</p>
<label>API Key</label>
<input type="password" id="key" placeholder="Paste your API key" autofocus />
<div class="error" id="auth-error">Invalid API key</div>
<button class="btn" onclick="load()">Sign in</button>
</div>
</div>

<div class="dash" id="dash">
<div class="side">
<div class="logo"><em>Form</em>Keeper</div>
<div class="nav-item active" onclick="showForms()">
<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M2 6h12"/></svg>
Forms
</div>
<div class="nav-item" onclick="showAbout()">
<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></svg>
About
</div>
<div class="spacer"></div>
<div class="logout" onclick="logout()">Sign out</div>
</div>
<div class="main" id="main">
<div class="top">
<h2 id="page-title">Forms</h2>
<button class="btn" onclick="showNewForm()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 1v12M1 7h12"/></svg>New form</button>
</div>
<div id="page-content"></div>
</div>
</div>

<div class="modal-overlay" id="modal">
<div class="modal">
<h2>New form</h2>
<p class="sub">Give your form a name and a URL slug. You'll get an endpoint URL to use in your HTML forms.</p>
<label>Form name</label>
<input type="text" id="f-name" placeholder="e.g. Contact" />
<div class="row">
<div><label>Slug</label><input type="text" id="f-slug" placeholder="e.g. contact" /></div>
<div><label>Email notification (optional)</label><input type="email" id="f-email" placeholder="you@example.com" /></div>
</div>
<div class="btns">
<button class="cancel" onclick="hideModal()">Cancel</button>
<button class="primary" onclick="createForm()">Create form</button>
</div>
</div>
</div>

<script>
let k = '';
const api = async (p, o = {}) => {
  o.headers = { ...o.headers, 'x-api-key': k, 'Content-Type': 'application/json' };
  const r = await fetch(p, o);
  return r.json();
};

function logout() {
  k = '';
  document.getElementById('auth').style.display = '';
  document.getElementById('dash').style.display = 'none';
  document.getElementById('key').value = '';
}

function showModal() { document.getElementById('modal').classList.add('show'); }
function hideModal() { document.getElementById('modal').classList.remove('show'); }

function showNewForm() {
  document.getElementById('f-name').value = '';
  document.getElementById('f-slug').value = '';
  document.getElementById('f-email').value = '';
  showModal();
}

async function createForm() {
  const name = document.getElementById('f-name').value.trim();
  const slug = document.getElementById('f-slug').value.trim();
  const email = document.getElementById('f-email').value.trim();
  if (!name || !slug) return;
  const r = await api('/api/forms', { method: 'POST', body: JSON.stringify({ name, slug, email_notification: email || undefined }) });
  if (r.error) { alert(r.error); return; }
  hideModal();
  showForms();
}

async function deleteForm(slug) {
  if (!confirm('Delete this form and all its submissions?')) return;
  await api('/api/forms/' + slug, { method: 'DELETE' });
  showForms();
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  return d.toLocaleDateString();
}

async function showForms() {
  document.getElementById('page-title').textContent = 'Forms';
  const d = await api('/api/forms');
  if (d.error) { document.getElementById('page-content').innerHTML = '<p style="color:#ef4444">Error loading forms.</p>'; return; }
  
  const forms = d.forms || [];
  const totalSubs = forms.reduce((s, f) => s + (f.submission_count || 0), 0);
  const todaySubs = forms.reduce((s, f) => s + (f.today_count || 0), 0);

  let html = '<div class="stats">' +
    '<div class="stat-card"><div class="num">' + forms.length + '</div><div class="lbl">Total forms</div></div>' +
    '<div class="stat-card"><div class="num">' + todaySubs + '</div><div class="lbl">Submissions today</div></div>' +
    '<div class="stat-card"><div class="num">' + totalSubs + '</div><div class="lbl">All submissions</div></div>' +
    '</div>';

  if (forms.length === 0) {
    html += '<p style="color:#6b6b76;text-align:center;padding:40px 0;font-size:0.875rem">No forms yet. Create your first one.</p>';
    document.getElementById('page-content').innerHTML = html;
    return;
  }

  for (const f of forms) {
    const url = window.location.origin + '/api/forms/' + f.slug + '/submit';
    html += '<div class="form-card">' +
      '<div class="info">' +
      '<h3>' + esc(f.name) + '<span class="form-badge">' + (f.submission_count || 0) + ' subs</span></h3>' +
      '<div class="meta">Created ' + timeAgo(f.created_at) + '</div>' +
      '<div class="url">' + esc(url) + '</div>' +
      '</div>' +
      '<div class="actions">' +
      '<button class="view" onclick="viewSubmissions(\'' + f.slug + '\')">View</button>' +
      '<button class="del" onclick="deleteForm(\'' + f.slug + '\')">Delete</button>' +
      '</div></div>';
  }
  document.getElementById('page-content').innerHTML = html;
}

async function viewSubmissions(slug) {
  document.getElementById('page-title').textContent = 'Submissions';
  const d = await api('/api/forms/' + slug + '/submissions');
  if (d.error) { document.getElementById('page-content').innerHTML = '<p style="color:#ef4444">Error.</p>'; return; }
  
  const subs = d.submissions || [];
  let html = '<div class="subs-header">' +
    '<h2>' + esc(d.form.name) + ' <span style="color:#6b6b76;font-weight:400;font-size:0.875rem">(' + subs.length + ' submissions)</span></h2>' +
    '<span class="back" onclick="showForms()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 3L5 7l4 4"/></svg>Back to forms</span>' +
    '</div>';

  if (subs.length === 0) {
    html += '<p style="color:#6b6b76;text-align:center;padding:40px 0;font-size:0.875rem">No submissions yet. Share the endpoint URL and wait for the first one.</p>';
    document.getElementById('page-content').innerHTML = html;
    return;
  }

  for (const s of subs) {
    const fields = Object.entries(s.data || {});
    let fhtml = '<div class="sub-detail">' +
      '<div class="time"><span>' + new Date(s.created_at).toLocaleString() + '</span><span>IP: ' + esc(s.ip || '-') + '</span></div>' +
      '<div class="fields">';
    for (const [key, val] of fields) {
      fhtml += '<div class="key">' + esc(key) + '</div><div class="val">' + esc(String(val)) + '</div>';
    }
    fhtml += '</div></div>';
    html += fhtml;
  }

  document.getElementById('page-content').innerHTML = html;
}

function showAbout() {
  document.getElementById('page-title').textContent = 'About';
  document.getElementById('page-content').innerHTML = '<div style="color:#6b6b76;font-size:0.875rem;line-height:1.8;max-width:480px">' +
    '<p style="margin-bottom:12px"><strong style="color:#e4e4e7">FormKeeper</strong> is an open-source form backend for Cloudflare Workers. MIT licensed.</p>' +
    '<p style="margin-bottom:12px">Stack: Cloudflare Workers + D1 + KV + Turnstile + Email Sending.</p>' +
    '<p><a href="https://github.com/TheForgivenOne/formkeeper" style="color:#3b82f6;text-decoration:underline">View on GitHub</a></p></div>';
}

async function load() {
  k = document.getElementById('key').value.trim();
  if (!k) { document.getElementById('auth-error').style.display = 'block'; return; }
  const d = await api('/api/forms');
  if (d.error) {
    document.getElementById('auth-error').style.display = 'block';
    return;
  }
  document.getElementById('auth-error').style.display = 'none';
  document.getElementById('auth').style.display = 'none';
  document.getElementById('dash').style.display = 'flex';
  showForms();
}

document.getElementById('key').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') load();
});
</script>
</body>
</html>`
