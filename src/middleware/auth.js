function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (req.accepts('html')) return res.redirect('/login');
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Login required' } });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  if (req.session.role !== 'admin') {
    return res.status(403).render('pages/error', {
      title: 'Forbidden',
      message: 'Admin access required.',
      user: req.user,
    });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
