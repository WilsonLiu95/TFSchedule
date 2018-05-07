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
/*
    参数设置 
    mysql_config mysql连接配置
    task_root_path 任务根路径
    port 端口号
    oauthLogin 授权登录函数
    callback 代表express listen的回调函数
*/
var userconfig = {};

var webApp = express();

var poolClient;

function runWeb(config) {
    var { task_root_path, mysql_config, oauthLogin, port } = config;
    userconfig = config;
    if (!task_root_path || !mysql_config || !oauthLogin) {
        throw new Error('请输入task_root_path与mysql_config与oauthLogin');
    }

    webApp.use(cookieParser());
    webApp.use(bodyParser.json());
    webApp.use(bodyParser.urlencoded());
    webApp.use(morgan('dev'));

    poolClient = mysql.createPool(mysql_config);
    // 调用授权登录函数
    oauthLogin && oauthLogin();
    webApp.use(express.static(path.join(__dirname, 'public'), {
        maxage: 86400000
    }));


    bindCgi();
    webApp.listen(userconfig.port || 8017, function () {
        console.log('Express server listening on port 8017');
        userconfig.callback && userconfig.callback();
    });
}

function bindCgi() {
    webApp.get('/getTaskList', wrap(function* (req, res) {
        var taskList = yield poolClient.query('select * from t_task_list');
        res.json(taskList)
    }));

    webApp.post('/getTaskExecList', wrap(function* (req, res) {
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
    webApp.get('/fileContent', wrap(function* (req, res) {
        var file_str = getFileContent(req.query.file_path)
        res.send(file_str);

    }));
    webApp.post('/updateTask', wrap(function* (req, res) {
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
}
// 获取对应选项列表
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
// 获取对应文件路径的内容
function getFileContent(file_path) {
    var { task_root_path } = userconfig;
    if (fs.existsSync(file_path)) {
        return fs.readFileSync(file_path);
    } else {
        var file_absoute_path = path.join(task_root_path, file_path);
        if (fs.existsSync(file_absoute_path)) {
            return fs.readFileSync(file_absoute_path);
        } else {
            return '文件不存在';
        }
    }
}

module.exports = {
    webApp, runWeb
}