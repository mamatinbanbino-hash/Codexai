const SYS = `Tu es un ingénieur logiciel senior. Tu reçois du code (n'importe quel langage) et une demande.
Règles strictes:
- Renvoie UNIQUEMENT le fichier complet modifié, sans explication, sans balises markdown.
- Conserve tout le code existant qui n'est pas concerné par la demande.
- Complète toutes les parties manquantes (fonctions vides, TODO, imports absents, accolades non fermées).
- Aucun placeholder, aucun "...", aucun "reste du code": tout doit être écrit en entier et fonctionner.
- Respecte le style, le langage et les conventions du code fourni.`;

const REVIEW = `Tu es un relecteur de code rigoureux. Tu reçois une demande et le code produit.
Vérifie: erreurs de syntaxe, imports manquants, variables non définies, fonctions appelées mais non écrites, parties tronquées, respect total de la demande.
Renvoie UNIQUEMENT le fichier complet corrigé (ou identique s'il est déjà correct), sans explication, sans balises markdown.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY absente dans les variables Vercel' });

  const { code = '', request = '', language = 'auto', mode = 'generate' } = req.body || {};
  if (!request.trim()) return res.status(400).json({ error: 'Demande vide' });
  if (code.length > 400000) return res.status(413).json({ error: 'Code trop long, découpe-le en parties' });

  const prompt = mode === 'review'
    ? `Demande d'origine:\n${request}\n\nLangage: ${language}\n\nCode à vérifier:\n${code}`
    : `Langage: ${language}\n\nDemande:\n${request}\n\nCode actuel (peut être vide):\n${code}`;

  const model = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();

  try {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: mode === 'review' ? REVIEW : SYS }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 65536 }
    });
    const models = [model, (process.env.GEMINI_FALLBACK_MODEL || '').trim()].filter(Boolean);
    let r;
    for (let i = 0; i < 4; i++) {
      const m = models[Math.min(i >= 2 ? 1 : 0, models.length - 1)];
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body
      });
      if (r.ok || ![429, 500, 503].includes(r.status)) break;
      await new Promise(ok => setTimeout(ok, 2000 * (i + 1)));
    }
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: t.slice(0, 600) });
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no'
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        if (!l.startsWith('data:')) continue;
        try {
          const j = JSON.parse(l.slice(5));
          const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
          if (t) res.write(t);
        } catch (_) {}
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
    else res.end();
  }
};
