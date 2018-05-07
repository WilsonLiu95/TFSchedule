var { runWeb,webApp } = require('../src/index')

runWeb({
    mysql_config: {
        host: 'localhost',
        port: '3306',
        user: 'root',
        password: '1234',
        database: 'db_schedule',
    },
    task_root_path: __dirname+ '/task',
    port: 8017,
    oauthLogin: function(){
        if (process.env.NODE_ENV == 'production') {

          } else {
            var MOCK_USER = {
              LoginName: 'wilsonsliu',
              ChineseName: '刘盛',
            };
            webApp.use(function (req, res, next) {
              if (!res.locals) res.locals = {}
              res.locals.userInfo = MOCK_USER;
              next();
            });
          }
    }
})