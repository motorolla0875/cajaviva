const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5200;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, app: 'CajaViva', hora: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`CajaViva escuchando en el puerto ${PORT}`));
