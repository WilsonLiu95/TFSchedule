var { run } = require('../src/index')
run({
    mysql_config: {
        host: 'localhost',
        port: '3306',
        user: 'root',
        password: '1234',
        database: 'db_lct_schedule',
    },
    task_root_path: __dirname+ '/task',
    defaultRtx: 'wilsonsliuxyz@gmail.com'
})
