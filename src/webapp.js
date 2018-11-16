const path = require('path');
const fs = require('fs');
const moment = require('moment');
const mysql = require('promise-mysql');

const express = require('express');
const wrap = require('co-express');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const parser = require('cron-parser');

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
        if (exitCode !== undefined) {
            if (exitCode === null) {
                whereList.push('exitCode is null');
            } else {
                whereList.push(`exitCode='${exitCode}'`);
            }

        }

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
        var { taskRootPath } = userconfig;
        // 先判断是否正确传参
        const filePath = req.query && req.query.filePath;
        if (!req.query.filePath) { return '请指定日志文件';}

        const fileAbsoutePath = path.join(taskRootPath, filePath);

        // 只允许获取根目录下文件
        const isFileInTaskRootDir = fileAbsoutePath.indexOf(taskRootPath) !== -1;
        if (!isFileInTaskRootDir) { return '只接受获取任务根目录下的文件';}

        // 文件是否存在
        if (!fs.existsSync(fileAbsoutePath)) { return '文件不存在';}
        // 存在且是文件，非文件夹
        const isGetFile = fs.statSync(fileAbsoutePath).isFile();
        if (!isGetFile) {return '只接受获取文件';}

        // 只允许获取指定路径下文件
        var relaPath = path.relative(taskRootPath, fileAbsoutePath);
        // window与linux路径符号不同进行兼容
        // 只允许获取logs与history目录下的的文件
        if (!/(\/|\\)(logs|history)(\/|\\)/g.test(relaPath)) { return '只允许获得指定路径下的文件'; }

        return res.sendFile(fileAbsoutePath);
    }));
    webApp.post('/updateTask', wrap(function* (req, res) {
        var taskInfo = req.body;
        var keyList = [];
        var valueList = [];
        var sqlTpl, sql;

        var {isValidate, errMsg} = checkValidateTask(taskInfo);
        if (!isValidate) {
            return res.json({
                retcode: -1,
                retmsg: errMsg
            });
        }
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
            taskInfo.modify_time = moment().format('YYYY-MM-DD HH:mm:ss');
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
        try {
            yield poolClient.query(sql);
        } catch (error) {
            console.error(error);
            // detached Boolean Not NULL DEFAULT FALSE COMMENT '是否使任务进程成为独立进程，避免批跑框架退出导致正在运行的进程退出'
            if (/Unknown column 'detached'/.test(error.message)) {
                yield poolClient.query('ALTER TABLE t_task_list ADD detached Boolean Not NULL DEFAULT FALSE COMMENT "是否使任务进程成为独立进程，避免批跑框架退出导致正在运行的进程退出"');
                // 新增字段后，再次尝试更新
                yield poolClient.query(sql);
                res.json({ retcode: 0 });
            }
            return res.json({retcode: -1, retmsg: `${error.message}\n${error.stack}`});
        }
        res.json({ retcode: 0 });
    }));
}
/**
 * @description 检查任务是否有效
 *  */
function checkValidateTask(taskInfo) {
    try {
        const {
            rule
        } = taskInfo;
        // 校验任务规则是否可以解析
        if (rule) {
            parser.parseExpression(rule);
        }
    } catch (err) {
        console.error(err);
        return {isValidate: false, errMsg: err.message};
    }
    return {isValidate: true};
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

module.exports = {
    webApp, runWeb
};
