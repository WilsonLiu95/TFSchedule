const path = require('path');
const fs = require('fs');
const moment = require('moment');
const mysql = require('promise-mysql');

const express = require('express');
const wrap = require('co-express');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
var srcPath = __dirname;
/*
    参数设置
    mysqlConfig mysql连接配置
    taskRootPath 任务根路径
    port 端口号
    oauthLogin 授权登录函数
    callback 代表express listen的回调函数
*/
var userconfig = {};

var webApp = express();

var poolClient;

function runWeb(config) {
    var { taskRootPath, mysqlConfig, oauthLogin, port, callback } = config;
    userconfig = config;
    if (!taskRootPath || !mysqlConfig || !oauthLogin) {
        throw new Error('请输入taskRootPath与mysqlConfig与oauthLogin');
    }

    webApp.use(cookieParser());
    webApp.use(bodyParser.json());
    webApp.use(bodyParser.urlencoded());
    webApp.use(morgan('dev'));

    poolClient = mysql.createPool(mysqlConfig);
    // 调用授权登录函数
    oauthLogin && oauthLogin();
    webApp.use(express.static(path.join(srcPath, 'public'), {
        maxage: 86400000
    }));


    bindCgi();
    webApp.listen(port || 8017, function () {
        console.log('Express server listening on port 8017');
        callback && callback();
    });
}

function bindCgi() {
    webApp.get('/getTaskList', wrap(function* (req, res) {
        var taskList = yield poolClient.query('select * from t_task_list');
        res.json(taskList);
    }));

    webApp.post('/getTaskExecList', wrap(function* (req, res) {
        var whereList = [];
        const { taskName, daterange, exitCode } = req.body;
        if (daterange && daterange[0] && daterange[1]) {
            whereList.push(`startTime>="${moment(daterange[0]).format('YYYY-MM-DD HH:mm:ss')}"`);
            whereList.push(`startTime<="${moment(daterange[1]).format('YYYY-MM-DD HH:mm:ss')}"`);
        }
        taskName && whereList.push(`taskName='${taskName}'`);
        exitCode && whereList.push(`exitCode='${exitCode}'`);
        var whereSql = '';
        whereList.length && (whereSql = `where ${whereList.join(' and ')}`);
        var sql = `select * from t_task_exec_list ${whereSql} order by startTime desc`;
        var data = yield {
            history: poolClient.query(sql),
            selectConfig: getSelectConfig(whereSql)
        };

        res.json(data);
    }));
    webApp.get('/fileContent', wrap(function* (req, res) {
        var fileStr = getFileContent(req.query.filePath);
        res.send(fileStr);

    }));
    webApp.post('/updateTask', wrap(function* (req, res) {
        var taskInfo = req.body;
        var keyList = [];
        var valueList = [];
        var sqlTpl, sql;

        // 赋值操作人员
        if (res.locals && res.locals.userInfo && res.locals.userInfo.LoginName) {
            taskInfo.operator = res.locals.userInfo.LoginName;
        }

        if (taskInfo.type && taskInfo.type === 'add') {
            // 新增任务
            delete taskInfo.type;
            for (const key in taskInfo) {
                if (taskInfo[key] !== null) {
                    keyList.push(key);
                    valueList.push(taskInfo[key]);
                }
            }
            sqlTpl = `insert into t_task_list  (${keyList.join(',')})  VALUES (?)`;
            sql = mysql.format(sqlTpl, [valueList]);
        } else {
            // 更新任务
            const taskName = taskInfo.taskName;
            delete taskInfo.taskName;
            if (!taskName) {
                return res.json({ retcode: 1, retmsg: '请输入任务名称' });
            }
            for (const key in taskInfo) {
                if (taskInfo[key] !== null) {
                    keyList.push(`${key} = ?`);
                    valueList.push(taskInfo[key]);
                }
            }
            sqlTpl = `update t_task_list set ${keyList.join(',')}  where taskName='${taskName}' limit 1`;
            sql = mysql.format(sqlTpl, valueList);
        }
        console.log(sql);
        yield poolClient.query(sql);
        res.json({ retcode: 0 });
    }));
}
// 获取对应选项列表
function* getSelectConfig(whereSql) {
    var data = {};
    const keyList = ['taskName', 'exitCode'];
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
function getFileContent(filePath) {
    var fileAbsoutePath;
    var { taskRootPath } = userconfig;
    if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath);
    } else {
        fileAbsoutePath = path.join(taskRootPath, filePath);
        if (fs.existsSync(fileAbsoutePath)) {
            return fs.readFileSync(fileAbsoutePath);
        } else {
            return '文件不存在';
        }
    }
}

module.exports = {
    webApp, runWeb
};
