const fs = require('fs-extra');
const path = require('path');
var sqlStr1 = 
`
CREATE TABLE IF NOT EXISTS t_task_list (
    id int(11) NOT NULL AUTO_INCREMENT,
    task_name varchar(64) NOT NULL COMMENT '任务命名，也是任务id，需要与文件夹目录一致',
    rtx_list varchar(256) NOT NULL COMMENT '相关人士的rtx列表，以分号分隔',
    title varchar(64) DEFAULT NULL COMMENT '任务名称',
    description varchar(512) DEFAULT NULL COMMENT '任务描述',
    rule varchar(64) DEFAULT NULL COMMENT '定时器的规则',
    task_version varchar(64) DEFAULT NULL COMMENT '当前运行任务的版本号',
    task_status tinyint(4) NOT NULL DEFAULT '0' COMMENT '任务的状态 0: 正常 1. 设置为无效(不影响当前正在运行的进程) 2. 设置为无效并且杀死当前进程',
    timeout int(11) NOT NULL DEFAULT '60' COMMENT '每次任务多久算超时，以秒为单位',
    last_start_time datetime DEFAULT CURRENT_TIMESTAMP COMMENT '上次任务开始的时间',
    last_end_time datetime DEFAULT CURRENT_TIMESTAMP COMMENT '上次任务结束的时间',
    last_warning_time datetime DEFAULT CURRENT_TIMESTAMP COMMENT '上次超时发送警告的时间',
    last_exit_code varchar(64) DEFAULT NULL COMMENT '上次退出的状态 0:正常 1: error触发的关闭 2: 子进程被父进程杀死 100以内为保留状态码，任务自定义使用100以上的状态码',
    modify_time datetime DEFAULT CURRENT_TIMESTAMP COMMENT '修改时间',
    create_time datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    operator varchar(64) DEFAULT NULL COMMENT '操作者',
    PRIMARY KEY (id),
    UNIQUE KEY task_id (task_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8;
`;

var sqlStr2 = 
`
CREATE TABLE IF NOT EXISTS db_lct_schedule.t_task_exec_list (
  id int(11) NOT NULL AUTO_INCREMENT,
  task_name varchar(64) NOT NULL COMMENT '任务命名，也是任务id，需要与文件夹目录一致',
  task_version varchar(64) DEFAULT NULL COMMENT '本次执行的版本号',
  start_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '任务开始的时间',
  end_time DATETIME COMMENT '任务结束的时间',
  exit_code int(11) COMMENT '退出的状态 0:正常 1: error触发的关闭 2: 子进程被父进程杀死 100以内为保留状态码，任务自定义使用100以上的状态码',
  warning_time DATETIME DEFAULT NULL COMMENT '上次超时发送警告的时间',
  duration int(11) DEFAULT 0 COMMENT '任务执行时间',
  logs text DEFAULT NULL COMMENT '本次版本的日志输出',
  publish_file_list text DEFAULT NULL COMMENT '发布文件列表',
  primary key(id)
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8; 
`;

function* initDb(mysql_client) {
    yield mysql_client.query(sqlStr1);
    yield mysql_client.query(sqlStr2);
  }
module.exports = { initDb }