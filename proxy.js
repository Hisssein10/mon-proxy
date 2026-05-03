/**
 * PROXY TRANSPARENT — IP du visiteur préservée
 * 
 * Ce serveur :
 * 1. Reçoit la demande de page du navigateur du visiteur
 * 2. Fait le fetch() vers le site externe
 * 3. Supprime les headers CORS et X-Frame-Options
 * 4. Réécrit les URLs dans le HTML pour tout faire passer par le proxy
 * 5. Renvoie le HTML au visiteur → son IP est utilisée pour les assets
 */

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const app     = express();

// ── Configuration ──────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const MON_DOMAINE = process.env.DOMAINE || `http://localhost:${PORT}`;

// ── Middleware : servir les fichiers statiques (ta page HTML) ───
app.use(express.static(path.join(__dirname, 'public')));

// ── Route proxy principale ──────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).send('Paramètre url manquant');
  }

  // Valider que c'est bien une URL HTTP
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).send('URL invalide');
    }
  } catch {
    return res.status(400).send('URL malformée');
  }

  try {
    // Faire la requête depuis le serveur
    // (le serveur retire les restrictions, ensuite le JS tourne chez le visiteur)
    const response = await fetch(targetUrl, {
      headers: {
        // On transmet le User-Agent du visiteur s'il est disponible
        'User-Agent': req.headers['x-visitor-ua'] || req.headers['user-agent'] || 
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': req.headers['accept-language'] || 'fr-FR,fr;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': parsedUrl.origin,
        'DNT': '1',
      },
      redirect: 'follow',
    });

    // ── Supprimer les headers qui bloquent l'affichage ──────────
    const blockedHeaders = [
      'x-frame-options',
      'content-security-policy',
      'x-content-type-options',
      'strict-transport-security',
      'access-control-allow-origin',
    ];

    // Copier les headers de la réponse sauf les bloquants
    for (const [key, value] of response.headers.entries()) {
      if (!blockedHeaders.includes(key.toLowerCase())) {
        try { res.setHeader(key, value); } catch {}
      }
    }

    // Ajouter nos propres headers CORS permissifs
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('X-Frame-Options', 'ALLOWALL');

    const contentType = response.headers.get('content-type') || '';

    // ── Si c'est du HTML : réécrire les URLs ────────────────────
    if (contentType.includes('text/html')) {
      let html = await response.text();
      const baseOrigin = parsedUrl.origin;

      // Réécrire les URLs absolues (http://...) → /proxy?url=...
      html = html.replace(
        /(href|src|action)="(https?:\/\/[^"]+)"/gi,
        (match, attr, url) => `${attr}="${MON_DOMAINE}/proxy?url=${encodeURIComponent(url)}"`
      );

      // Réécrire les URLs relatives (/chemin) → /proxy?url=origine/chemin
      html = html.replace(
        /(href|src|action)="(\/(?!\/)[^"]*?)"/gi,
        (match, attr, chemin) => `${attr}="${MON_DOMAINE}/proxy?url=${encodeURIComponent(baseOrigin + chemin)}"`
      );

      // Réécrire les URLs de protocole relatif (//domaine/...)
      html = html.replace(
        /(href|src|action)="(\/\/[^"]+)"/gi,
        (match, attr, url) => `${attr}="${MON_DOMAINE}/proxy?url=${encodeURIComponent('https:' + url)}"`
      );

      // Réécrire aussi les URLs dans les srcset
      html = html.replace(
        /srcset="([^"]+)"/gi,
        (match, srcset) => {
          const rewritten = srcset.replace(
            /(https?:\/\/[^\s,]+)/g,
            url => `${MON_DOMAINE}/proxy?url=${encodeURIComponent(url)}`
          );
          return `srcset="${rewritten}"`;
        }
      );

      // Injecter notre script d'automatisation dans le <head>
      const scriptInjection = `
<script>
/* ── Script injecté par le proxy ── */
(function() {
  // Intercepter les navigations dans la page pour les faire passer par le proxy
  document.addEventListener('click', function(e) {
    const a = e.target.closest('a');
    if (a && a.href && !a.href.startsWith('${MON_DOMAINE}/proxy')) {
      if (a.href.startsWith('http')) {
        e.preventDefault();
        window.location.href = '${MON_DOMAINE}/proxy?url=' + encodeURIComponent(a.href);
      }
    }
  }, true);

  // Intercepter les formulaires
  document.addEventListener('submit', function(e) {
    const form = e.target;
    if (form.action && !form.action.startsWith('${MON_DOMAINE}/proxy')) {
      e.preventDefault();
      const newAction = '${MON_DOMAINE}/proxy?url=' + encodeURIComponent(form.action);
      form.action = newAction;
      form.submit();
    }
  }, true);

  console.log('[Proxy] Script d automatisation actif');
})();
</script>`;

      html = html.replace(/<head>/i, '<head>' + scriptInjection);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);

    } else {
      // Pour les autres types (CSS, JS, images) : passer directement
      const buffer = await response.buffer();
      res.send(buffer);
    }

  } catch (err) {
    console.error('Erreur proxy:', err.message);
    res.status(500).send(`
      <html><body style="font-family:sans-serif;padding:2rem">
        <h2>Erreur de chargement</h2>
        <p>${err.message}</p>
        <p>Certains sites bloquent les requêtes externes même depuis un proxy.</p>
      </body></html>
    `);
  }
});

// ── Démarrage ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Proxy actif sur ${MON_DOMAINE}`);
  console.log(`📌 Test : ${MON_DOMAINE}/proxy?url=https://fr.wikipedia.org`);
});
