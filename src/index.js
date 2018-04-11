const path = require('path');
const fs = require('fs-extra');

// 引入 events 模块 创建 eventEmitter 对象
var events = require('events');
var eventEmitter = new events.EventEmitter();

const schedule = require('node-schedule');
const parser = require('cron-parser');
const moment = require('moment');

const mysql = require('promise-mysql');
const co = require('co');

const { startExecTask, endExecTask } = require('./lib/hook');
const { monitorHelper } = require('./lib/monitorHelper');
const {initDb} = require('./lib/initDb');
const { execTask } = require('./lib/execTask');

var G_child_process_hanlde_map = {}; // 存储子进程list，超时进行kill
var G_task_schedule_list = {};// 存储任务列表，rule刷新进行cancel，并重新挂载 
var G_task_map = {};// key为task_name,value为定时规则
var G_pool_client;
var app = { G_child_process_hanlde_map, G_task_schedule_list, G_task_map };
// 启动运行

function run({ task_root_path, mysql_config }) {
  if (!task_root_path || !mysql_config) {
    throw new Error('请输入mysql_config,task_root_path');
  }

  G_pool_client = mysql.createPool(mysql_config);
  
  Object.assign(app, { execTask, eventEmitter, G_pool_client, task_root_path, mysql_config });
  co(function* () {
    yield initDb(G_pool_client);
    yield startSystem();
    
    bindEvent(app); // 绑定事件
  }).catch(function (e) {
    eventEmitter.emit('waring', { content: `${e.message} \n ${e.stack}`, title: '批跑系统系统失败' })
  })
}

// 系统启动函数
function* startSystem() {

  // 1. 查询数据库中所有任务
  var taskList = yield app.G_pool_client.query('select task_name,rule from t_task_list');
  eventEmitter.emit('waring', { title: `批跑系统开始启动,共有${taskList.length}项定时任务`, content: JSON.stringify(taskList) })

  // 2. 将当前数据库中的任务与规则 存储在全局对象G_task_map中,并挂载任务到定时器上
  taskList.forEach(({ task_name, rule }) => {
    G_task_map[task_name] = rule;

    console.log(`(${task_name})-挂载定时器，按照${rule}规则定时执行`);
    G_task_schedule_list[task_name] = schedule.scheduleJob(rule, function () {
      execTask(task_name, app);
    });
  });

  // 3. 绑定监控小助手
  console.log('========监控小助手启动=============');
  schedule.scheduleJob('*/3 * * * * *', function () {
    var monitor_start_time = Date.now();
    monitorHelper(app).then(function () {
      var duration = Date.now() - monitor_start_time;
      if (duration > 1000) { // 如果执行时间超过1S则输出标记
        console.log(`(monitorHelper)本次监控小助手-执行完成,耗时${duration}毫秒`);
      }
    }).catch(e => {
      eventEmitter.emit('waring', { title: `(monitorHelper)监控小助手-异常出错`, content: `${e.message} - ${e.toString()}` })
    });
  });

}

function bindEvent(app) {
  // 任务开始
  var { G_pool_client } = app;
  eventEmitter.on('task_start', function ({ task_name, task_version }) {
    co(function* () {
      yield startExecTask({ task_name, task_version }, app); // 任务开始运行的钩子函数
    });
  });
  // 任务结束
  eventEmitter.on('task_end', function ({ task_name, exit_code, task_version, error_log_list }, app) {
    co(function* () {
      yield endExecTask({ task_name, exit_code, task_version, error_log_list }, app);
    });
  });
  // 监听告警
  eventEmitter.on('waring', function ({ title, content, task_name }) {
    co(function* () {
      console.log(`waring-${task_name}`, title, content, );
      yield G_pool_client.query(`update t_task_list SET last_warning_time='${moment().format('YYYY-MM-DD HH:mm:ss')}' where task_name="${task_name}"`);
    })
  });
}
module.exports = {
  run, eventEmitter, app
}