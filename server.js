'use strict';

const { createApp } = require('./src/http');
const { systemClock } = require('./src/clock');

const port = Number(process.env.PORT || 3000);
const dbFile = process.env.DB_FILE || null; // 可选：写穿持久化到 JSON 文件

const app = createApp({ clock: systemClock(), dbFile });
app.server.listen(port, () => {
  console.log(`市容考核规则版本闭环服务已启动: http://localhost:${port}`);
  console.log(`OpenAPI: http://localhost:${port}/openapi.json`);
  if (dbFile) console.log(`数据文件: ${dbFile}`);
});
