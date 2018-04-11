const path = require('path');
const fs = require('fs');
const moment = require('moment');
const mysql = require('promise-mysql');

const express = require('express');
const wrap = require('co-express');
const morgan = require('morgan')
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');

const co = require('co');

const app = express();
// 可以在这里使用中间件
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded());
app.use(morgan('dev'));
const task_root_path = path.join(__dirname, '..');

if (process.env.NODE_ENV == 'production') {
  var lct_schedule = {
    host: 'localhost',
    port: '3306',
    user: 'root',
    password: '1234',
    database: 'db_lct_schedule',
  };
} else {
  var lct_schedule = {
    host: 'localhost',
    port: '3306',
    user: 'root',
    password: '1234',
    database: 'db_lct_schedule',
  };
}
const poolClient = mysql.createPool(lct_schedule);

if (process.env.NODE_ENV == 'production') {
  // 线上登录鉴权
} else {
  var MOCK_USER = {
    LoginName: 'wilsonsliu',
    ChineseName: '刘盛',
  };
  app.use(function (req, res, next) {
    if (!res.locals) res.locals = {}
    res.locals.userInfo = MOCK_USER;
    next();
  })
}
app.use(express.static(path.join(__dirname, 'public'), {
  maxage: 86400000
}));

app.get('/getTaskList', wrap(function* (req, res) {
  var taskList = yield poolClient.query('select * from t_task_list');
  res.json(taskList)
}));

app.post('/getTaskExecList', wrap(function* (req, res) {
  var whereList = [];
  const { task_name, daterange, exit_code } = req.body;
  if (daterange && daterange[0] && daterange[1]) {
    whereList.push(`start_time>="${moment(daterange[0]).format('YYYY-MM-DD HH:mm:ss')}"`);
    whereList.push(`start_time<="${moment(daterange[1]).format('YYYY-MM-DD HH:mm:ss')}"`);
  }
  task_name && whereList.push(`task_name='${task_name}'`);
  exit_code && whereList.push(`exit_code='${exit_code}'`);
  var whereSql = '';
  whereList.length && (whereSql = `where ${whereList.join(' and ')}`)
  var sql = `select * from t_task_exec_list ${whereSql} order by start_time desc`;
  var data = yield {
    history: poolClient.query(sql),
    select_config: getSelectConfig(whereSql),
  };

  res.json(data);
}));
app.get('/fileContent', wrap(function* (req, res) {
  var file_str = getFileContent(req.query.file_path)
  res.send(file_str);

}));
app.post('/updateTask', wrap(function* (req, res) {
  var taskInfo = req.body;
  var key_list = [];
  var value_list = [];
  var isAdd = false;
  var sql_tpl, sql;
  if (taskInfo.type && taskInfo.type == 'add') {
    delete taskInfo.type;
    taskInfo.operator = res.locals.userInfo.LoginName;
    console.log(taskInfo)
    for (var key in taskInfo) {
      if (taskInfo[key] !== null) {
        key_list.push(key);
        value_list.push(taskInfo[key]);
      }
    }
    sql_tpl = `insert into t_task_list  (${key_list.join(',')})  VALUES (?)`;
    sql = mysql.format(sql_tpl, [value_list]);
  } else {
    const task_name = req.body.task_name;
    delete req.body.task_name;
    if (!task_name) {
      return res.json({ retcode: 1, retmsg: '请输入任务名称' })
    }
    taskInfo.operator = res.locals.userInfo.LoginName;
    for (var key in taskInfo) {
      if (taskInfo[key] !== null) {
        key_list.push(`${key} = ?`);
        value_list.push(taskInfo[key]);
      }
    }
    sql_tpl = `update t_task_list set ${key_list.join(',')}  where task_name='${task_name}' limit 1`;
    sql = mysql.format(sql_tpl, value_list);
  }
  console.log(sql)
  yield poolClient.query(sql);
  res.json({ retcode: 0 });
}));
function* getSelectConfig(whereSql) {
  var data = {};
  const keyList = ['task_name', 'exit_code'];
  yield keyList.map(key => {
    return function* () {
      var list = yield poolClient.query(`select count(1),${key} from t_task_exec_list ${whereSql} group by ${key} order by count(1) desc`);
      data[key] = [];
      list.forEach(item => {
        data[key].push([item[key], item['count(1)']]);
      });
    };
  });
  return data;
}
function getFileContent(file_path) {
  if (fs.existsSync(file_path)) {
    return fs.readFileSync(file_path);
  } else {    
    var file_absoute_path = path.join(task_root_path, file_path);
    if(fs.existsSync(file_absoute_path)){
      return fs.readFileSync(file_absoute_path);
    }else{
      return '文件不存在';
    }
  }


}

app.listen(8017, function () {
  console.log('Express server listening on port 8017');
});
