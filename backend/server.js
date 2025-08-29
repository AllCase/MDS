const express = require('express');
const app = express();

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

app.get('/api/test', (req, res) => {
  res.json({ message: 'Test endpoint works' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});