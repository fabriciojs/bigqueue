var should = require('should'),
    redis = require('redis'),
    ZK = require('zookeeper'),
    utils = require('../lib/bq_client_utils.js'),
    bq = require('../lib/bq_client.js'),
    bj = require("../lib/bq_journal_client_redis.js"),
    bqc = require('../lib/bq_cluster_client.js'),
    log = require('node-logging'),
    fs = require('fs')

var j = 0
describe("Big Queue Cluster",function(){
    
    //Prepare stage
    var clusterPath = "/bq/clusters/test"

    var zkConfig = {
            connect: "localhost:2181",
            timeout: 200000,
            debug_level: ZK.ZOO_LOG_LEVEL_WARN,
            host_order_deterministic: false
        }   

    var zk = new ZK(zkConfig)
    zk.setMaxListeners(200)
    var bqClientConfig = {
        "zk":zk,
        "refreshTime":500,
        "zkClusterPath":clusterPath,
        "createJournalClientFunction":bj.createJournalClient,
        "createNodeClientFunction":bq.createClient,

    }

 
    var bqClient
    var redisClient1
    var redisClient2
    var journalClient1
    var journalClient2
    
    before(function(done){
        var execute = function() {
          var args = [];
          for (var key in arguments) {
            args.push(arguments[key]);
          }
          var command = args.shift();
          var callback = args.pop();
          return this.send_command(command, args, callback);
        }

        log.setLevel("critical")
        redisClient1 = redis.createClient(6379,"127.0.0.1",{"return_buffers":false})
        redisClient1.execute = execute;
        redisClient1.on("ready",function(){
            redisClient2= redis.createClient(6380,"127.0.0.1",{"return_buffers":false})
            redisClient2.execute = execute;
            redisClient2.on("ready",function(){
                done()
            })
        })
    }) 

    before(function(done){
         zk.connect(function(err){
            if(err){
                done(err)
            }else{
                done()  
            }
        })
    });
    
    before(function(done){
        journalClient1 = bj.createJournalClient({host:"127.0.0.1",port:6379})
        journalClient1.on("ready",function(){
            journalClient2 = bj.createJournalClient({host:"127.0.0.1",port:6380})
            journalClient2.on("ready",function(){
                done()
            })
        })
    })
    
    beforeEach(function(done){
        redisClient1.execute("flushall",function(err,data){
            redisClient2.execute("flushall",function(err,data){
                done()
            })
        })
    })
   
    beforeEach(function(done){
        utils.deleteZkRecursive(zk,"/bq",function(){
        zk.a_create("/bq","",0,function(rc,error,path){    
            zk.a_create("/bq/clusters","",0,function(rc,error,path){
                zk.a_create("/bq/clusters/test","",0,function(rc,error,path){
                        zk.a_create("/bq/clusters/test/topics","",0,function(rc,error,path){
                            zk.a_create("/bq/clusters/test/nodes","",0,function(rc,error,path){
                                zk.a_create("/bq/clusters/test/journals","",0,function(rc,error,path){
                                    zk.a_create("/bq/clusters/test/nodes/redis1",JSON.stringify({"host":"127.0.0.1","port":6379,"errors":0,"status":"UP", "journals":["j1","j2"]}),0,function(rc,error,path){
                                        zk.a_create("/bq/clusters/test/nodes/redis2",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"UP", "journals":["j1","j2"]}),0,function(rc,error,path){
                                            zk.a_create("/bq/clusters/test/journals/j1",JSON.stringify({"host":"127.0.0.1","port":6379,"errors":0,"status":"UP"}),0,function(rc,error,path){
                                                zk.a_create("/bq/clusters/test/journals/j2",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"UP"}),0,function(rc,error,path){
                                                    bqClient = bqc.createClusterClient(bqClientConfig)
                                                    bqClient.on("ready",function(){
                                                        done()
                                                    })
                                                })
                                            })
                                        })
                                    })
                                })
                            })
                        })
                    })
                })
            })
        })
    }) 

    afterEach(function(done){
        bqClient.shutdown()
        process.nextTick(function(){
            done()
        })
    })

    after(function(done){
        zk.close()
        process.nextTick(function(){
            done()
        })

    })
    //End of prepare stage 
    describe("#internals",function(){
        it("should register router on startup")
        it("should get host and port from id if isn't present on json data",function(done){
            zk.a_create("/bq/clusters/test/nodes/redis2-2020",JSON.stringify({"errors":0,"status":"DOWN"}),0,function(rc, err,stat){
                rc.should.equal(0)
                setTimeout(function(){
                    var node = bqClient.getClientById(bqClient.nodes,"redis2-2020")
                    node.host.should.equal("redis2")
                    node.port.should.equal("2020")
                    done()
                },200)
            })

        })
    })

    describe("#createTopic",function(){
        it("should register the topic after creation and create the consumer node",function(done){
            bqClient.createTopic("testTopic",function(err){
                should.not.exist(err)
                zk.a_exists(clusterPath+"/topics/testTopic",false,function(rc,error,stat){
                    zk.a_exists(clusterPath+"/topics/testTopic/consumerGroups",false,function(rc,error,stat){
                        if(rc!=0){
                            done(rc+"-"+error)
                        }else{
                            done()
                        }
                    })
                })
            })
        })
        it("should register the ttl as topic property",function(done){
            bqClient.createTopic("testTopic",10,function(err){
                should.not.exist(err)
                zk.a_exists(clusterPath+"/topics/testTopic",false,function(rc,error,stat){
                    zk.a_get(clusterPath+"/topics/testTopic",false,function(rc,error,stat,data){
                        var d = JSON.parse(data)
                        d.ttl.should.equal(10)
                        done()
                    })
                })
            })

        })
        it("should propagate the create throught all redis",function(done){
            bqClient.createTopic("testTopic",function(err){
                should.not.exist(err)
                redisClient1.execute("sismember","topics","testTopic",function(err,data){
                    should.not.exist(err)
                    data.should.equal(1)
                    redisClient2.execute("sismember","topics","testTopic",function(err,data){
                        should.not.exist(err)
                        data.should.equal(1)
                        done()
                    })
                })
            })
        })
        it("should fail if there are any redis with problems",function(done){
            zk.a_set("/bq/clusters/test/nodes/redis2",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"DOWN"}),-1,function(rc, err,stat){
                rc.should.equal(0)
                var client = bqc.createClusterClient(bqClientConfig)
                client.once("ready",function(){
                    client.createTopic("testTopic",function(err){
                        should.exist(err)
                        client.shutdown()
                        done()            
                    })
                })
            })
        })
        it("should fail if the topic already exist",function(done){
            bqClient.createTopic("testTopic",function(err){
                should.not.exist(err)
                bqClient.createTopic("testTopic",function(err){
                    should.exist(err)
                    done()
                })
            })
        })

        it("should enable to create a topic with specific ttl",function(done){
            bqClient.createTopic("testTopic1",1,function(err){
                should.not.exist(err)
                redisClient1.execute("get","topics:testTopic1:ttl",function(err,data){
                    should.not.exist(err)
                    should.exist(data)
                    data.should.equal(""+1)
                    redisClient2.execute("get","topics:testTopic1:ttl",function(err,data){
                        should.not.exist(err)
                        should.exist(data)
                        data.should.equal(""+1)
                        bqClient.createTopic("testTopic2",2,function(err){
                            should.not.exist(err)
                            redisClient1.execute("get","topics:testTopic2:ttl",function(err,data){
                                should.not.exist(err)
                                should.exist(data)
                                data.should.equal(""+2)
                                redisClient2.execute("get","topics:testTopic2:ttl",function(err,data){
                                    should.not.exist(err)
                                    should.exist(data)
                                    data.should.equal(""+2)
                                    done()
                                })
                            })
                        })
                    })
                })
            })
        })
    })

    describe("#deleteTopic",function(done){
        beforeEach(function(done){
            bqClient.createTopic("testTopic",function(err){
                should.not.exist(err)
                zk.a_exists(clusterPath+"/topics/testTopic",false,function(rc,error,stat){
                    zk.a_exists(clusterPath+"/topics/testTopic/consumerGroups",false,function(rc,error,stat){
                        if(rc!=0){
                            done(rc+"-"+error)
                        }else{
                            done()
                        }
                    })
                })

            })
        })
        it("should remove the topic from all redis",function(done){
            bqClient.deleteTopic("testTopic",function(err){
                should.not.exist(err)
                redisClient1.execute("sismember","topics","testTopic",function(err,data){
                    should.not.exist(err)
                    data.should.equal(0)
                    redisClient2.execute("sismember","topics","testTopic",function(err,data){
                        should.not.exist(err)
                        data.should.equal(0)
                        done()
                    })
                })
            })
        })
        it("should remove topic from zookeeper",function(done){
            bqClient.deleteTopic("testTopic",function(err){
                should.not.exist(err)
                zk.a_exists(clusterPath+"/topics/testTopic",false,function(rc,error,stat){
                    if(rc==0){
                        done(rc+"-"+error)
                    }else{
                        done()
                    }
                })
            })
        })
        it("should fail if there are any redis with problems",function(done){
             zk.a_set("/bq/clusters/test/nodes/redis2",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"DOWN"}),-1,function(rc, err,stat){
                rc.should.equal(0)
                var client = bqc.createClusterClient(bqClientConfig)
                client.once("ready",function(){
                    client.deleteTopic("testTopic",function(err){
                        should.exist(err)
                        client.shutdown()
                        done()            
                    })
                })
            })
        })
        it("should fail if the topic doesn't exist",function(done){
            bqClient.deleteTopic("testTopic-not-exist",function(err){
                should.exist(err)
                done()
            })
        })
        it("should fail if the topic contains consumers",function(done){
            bqClient.createConsumerGroup("testTopic","testConsumer",function(err){
                should.not.exist(err)
                bqClient.deleteTopic("testTopic-not-exist",function(err){
                    should.exist(err)
                    done()
                })
            })
        })
    })


    describe("#createConsumer",function(done){
        beforeEach(function(done){
            bqClient.createTopic("testTopic",function(err){
                should.not.exist(err)
                done()
            })
        })
        it("should register the consumer group after creation",function(done){
            bqClient.createConsumerGroup("testTopic","testConsumer",function(err){
                should.not.exist(err)
                zk.a_exists(clusterPath+"/topics/testTopic/consumerGroups/testConsumer",false,function(rc,error,stat){
                    if(rc!=0){
                        done(rc+"-"+error)
                    }else{
                        done()
                    }
                })
            })
        })
        it("should fail if some registered server isn't up",function(done){
            zk.a_set("/bq/clusters/test/nodes/redis2",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"DOWN"}),-1,function(rc, err,stat){
                rc.should.equal(0)
                var client = bqc.createClusterClient(bqClientConfig)
                client.once("ready",function(){
                    client.createConsumerGroup("testTopic","testConsumer",function(err){
                        client.shutdown()
                        should.exist(err)
                        done()            
                    })
                })
            })
        })
        it("should propagate the creation through all nodes",function(done){
            bqClient.createConsumerGroup("testTopic","testConsumer",function(err){
                should.not.exist(err)
                redisClient1.execute("sismember","topics:testTopic:consumers","testConsumer",function(err,data){
                    should.not.exist(err)
                    data.should.equal(1)
                    redisClient2.execute("sismember","topics:testTopic:consumers","testConsumer",function(err,data){
                        should.not.exist(err)
                        data.should.equal(1)
                        done()
                    })
                })
            })
        })
        it("should fail if any redis get an error on create",function(done){
            redisClient2.execute("del","topics",function(err,data){
                should.not.exist(err)
                bqClient.createConsumerGroup("testTopic","testConsumer",function(err){
                    should.exist(err)
                    done()            
                })
            })
        })
    })

    describe("#deleteConsumer",function(done){
        beforeEach(function(done){
            bqClient.createTopic("testTopic",function(err){
                should.not.exist(err)
                bqClient.createConsumerGroup("testTopic","testConsumer",function(err){
                    should.not.exist(err)
                    done()
                })
            })
        })

        it("should remove consumer from zookeeper",function(done){
            zk.a_exists(clusterPath+"/topics/testTopic/consumerGroups/testConsumer",false,function(rc,error,stat){
                if(rc!=0){
                    done(rc+"-"+error)
                }else{
                    bqClient.deleteConsumerGroup("testTopic","testConsumer",function(err){
                        should.not.exist(err)
                        zk.a_exists(clusterPath+"/topics/testTopic/consumerGroups/testConsumer",false,function(rc,error,stat){
                            if(rc == 0){
                                done("Path should not exist")
                            }else{
                                done()
                            }
                        })
                    })
                }
            })
        })
        it("should remove consumer on all servers",function(done){
            redisClient1.execute("sismember","topics:testTopic:consumers","testConsumer",function(err,data){
                should.not.exist(err)
                data.should.equal(1)
                redisClient2.execute("sismember","topics:testTopic:consumers","testConsumer",function(err,data){
                    should.not.exist(err)
                    data.should.equal(1)
                    bqClient.deleteConsumerGroup("testTopic","testConsumer",function(err){
                        redisClient1.execute("sismember","topics:testTopic:consumers","testConsumer",function(err,data){
                            should.not.exist(err)
                            data.should.equal(0)
                            redisClient2.execute("sismember","topics:testTopic:consumers","testConsumer",function(err,data){
                                should.not.exist(err)
                                data.should.equal(0)
                                done()
                            })
                        })
                    })
                })
            })

        })
        it("should fail if any redis fails",function(done){
            redisClient2.execute("flushall",function(err,data){
                should.not.exist(err)
                bqClient.deleteConsumerGroup("testTopic","testConsumer",function(err){
                    should.exist(err)
                    done()            
                })
            })
        })
        it("should fail if consumer doesn't exist",function(done){
            bqClient.deleteConsumerGroup("testTopic","testConsumer-no-exists",function(err){
                should.exist(err)
                done()            
            })
        })
    })

    describe("#resetConsumer",function(done){
        beforeEach(function(done){
            bqClient.createTopic("testTopic",function(err){
                should.not.exist(err)
                bqClient.createConsumerGroup("testTopic","testConsumer",function(err){
                    should.not.exist(err)
                    done()
                })
            })
        })

        it("should reset consumer on all servers",function(done){
            redisClient1.execute("set","topics:testTopic:head","10",function(err,data){
                should.not.exist(err)
                redisClient2.execute("set","topics:testTopic:head","10",function(err,data){
                    should.not.exist(err)
                    bqClient.resetConsumerGroup("testTopic","testConsumer",function(err){
                        redisClient1.execute("get","topics:testTopic:consumers:testConsumer:last",function(err,data){
                            should.not.exist(err)
                            data.should.equal("11")
                            redisClient2.execute("get","topics:testTopic:consumers:testConsumer:last",function(err,data){
                                should.not.exist(err)
                                data.should.equal("11")
                                done()
                            })
                        })
                    })
                })
            })

        })
        it("should fail if any redis fails",function(done){
            redisClient2.execute("flushall",function(err,data){
                should.not.exist(err)
                bqClient.resetConsumerGroup("testTopic","testConsumer",function(err){
                    should.exist(err)
                    done()            
                })
            })
        })
        it("should fail if consumer doesn't exist",function(done){
            bqClient.resetConsumerGroup("testTopic","testConsumer-no-exists",function(err){
                should.exist(err)
                done()            
            })
        })
    })


    describe("#postMessage",function(){
        beforeEach(function(done){
            bqClient.createTopic("testTopic",function(err){
                should.not.exist(err)
                done()
            })
        })
        it("should balance the writes",function(done){
            bqClient.postMessage("testTopic",{msg:"test1"},function(err,key){
                bqClient.postMessage("testTopic",{msg:"test2"},function(err,key){
                    bqClient.postMessage("testTopic",{msg:"test3"},function(err,key){
                        bqClient.postMessage("testTopic",{msg:"test4"},function(err,key){
                            redisClient1.execute("get","topics:testTopic:head",function(err,data){
                                should.not.exist(err)
                                should.exist(data)
                                data.should.equal(""+2)
                                redisClient2.execute("get","topics:testTopic:head",function(err,data){
                                    should.not.exist(err)
                                    should.exist(data)
                                    data.should.equal(""+2)
                                    done()
                                })
                            })
                        })
                    })
                })
            })
        })
        it("should try to resend the message to another node if an error ocurrs sending",function(done){
            zk.a_create("/bq/clusters/test/nodes/redis3",JSON.stringify({"host":"127.0.0.1","port":6381,"errors":0,"status":"UP"}),0,function(rc,error,path){
                bqClient.shutdown() 
                bqClient = bqc.createClusterClient(bqClientConfig)
                bqClient.on("ready",function(){
                    bqClient.postMessage("testTopic",{msg:"test1"},function(err,key){
                        bqClient.postMessage("testTopic",{msg:"test2"},function(err,key){
                            bqClient.postMessage("testTopic",{msg:"test3"},function(err,key){
                                bqClient.postMessage("testTopic",{msg:"test4"},function(err,key){
                                    redisClient1.execute("get","topics:testTopic:head",function(err,data1){
                                        should.not.exist(err)
                                        should.exist(data1)
                                        redisClient2.execute("get","topics:testTopic:head",function(err,data2){
                                            should.not.exist(err)
                                            should.exist(data2)
                                            var sum = parseInt(data1)+parseInt(data2)
                                            sum.should.equal(4)
                                            done()
                                        })
                                    })
                                })
                            })
                        })
                    })
                })
            })
        })
      /*  
       *  Functional removed from 0.2.0
       *  it("should notify an error to zookeeper on node error",function(done){
            zk.a_create("/bq/clusters/test/nodes/redis3",JSON.stringify({"host":"127.0.0.1","port":6381,"errors":0,"status":"UP"}),0,function(rc,error,path){
                var oldData
                zk.aw_get("/bq/clusters/test/nodes/redis3",function(type,state,path){
                    zk.a_get(path,false,function(rc,error,stat,data){
                        var newData = JSON.parse(data)
                        newData.host.should.equal(oldData.host)
                        newData.port.should.equal(oldData.port)
                        done()
                    }) 
                },
                function (rc,error,stat,data){
                    oldData = JSON.parse(data)
                })
                bqClient.shutdown()
                bqClient = bqc.createClusterClient(bqClientConfig)
                bqClient.on("ready",function(){
                    bqClient.postMessage("testTopic",{msg:"test1"},function(err,key){
                        bqClient.postMessage("testTopic",{msg:"test2"},function(err,key){
                            bqClient.postMessage("testTopic",{msg:"test3"},function(err,key){
                            })
                        })
                    })
                })
            })
        })*/
        it("should write to all journals declared for the node",function(done){
            bqClient.postMessage("testTopic",{msg:"test1"},function(err,key1){
                bqClient.postMessage("testTopic",{msg:"test2"},function(err,key2){
                    journalClient1.retrieveMessages("redis1","testTopic",1,function(err,data){
                        should.not.exist(err)
                        should.exist(data)
                        data.should.have.length(1)
                        journalClient2.retrieveMessages("redis1","testTopic",1,function(err,data){
                            should.not.exist(err)
                            should.exist(data)
                            data.should.have.length(1)
                            journalClient1.retrieveMessages("redis2","testTopic",1,function(err,data){
                                should.not.exist(err)
                                should.exist(data)
                                data.should.have.length(1)
                                journalClient2.retrieveMessages("redis2","testTopic",1,function(err,data){
                                    should.not.exist(err)
                                    should.exist(data)
                                    data.should.have.length(1)
                                    done()
                                })
                            })
                        })
                    })
                })
            })
        })
       it("should return an error if an error ocurrs writing data to the journal",function(done){
           zk.a_create("/bq/clusters/test/journals/j3",JSON.stringify({"host":"127.0.0.1","port":6381,"errors":0,"status":"UP"}),0,function(rc, err,stat){
                zk.a_set("/bq/clusters/test/nodes/redis1",JSON.stringify({"host":"127.0.0.1","port":6379,"errors":0,"status":"UP", "journals":["j1","j2","j3"]}),-1,function(rc, err,stat){
                    zk.a_set("/bq/clusters/test/nodes/redis2",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"UP", "journals":["j1","j2","j3"]}),-1,function(rc, err,stat){
                       setTimeout(function(){
                            bqClient.postMessage("testTopic",{msg:"test1"},function(err,key){
                                should.exist(err)
                                done()
                            })
                        },500)
                    })
                })
            })
        })
       /*
        * Function removed in 0.2.0
        it("should increase the amount of errors of the failed journal",function(done){
           zk.a_create("/bq/clusters/test/journals/j3",JSON.stringify({"host":"127.0.0.1","port":6381,"errors":0,"status":"UP"}),0,function(rc, err,stat){
                zk.a_set("/bq/clusters/test/nodes/redis1",JSON.stringify({"host":"127.0.0.1","port":6379,"errors":0,"status":"UP", "journals":["j1","j2","j3"]}),-1,function(rc, err,stat){
                    zk.a_set("/bq/clusters/test/nodes/redis2",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"UP", "journals":["j1","j2","j3"]}),-1,function(rc, err,stat){
                        var oldData
                        zk.aw_get("/bq/clusters/test/journals/j3",function(type,state,path){
                            zk.a_get(path,false,function(rc,error,stat,data){
                                var newData = JSON.parse(data)
                                newData.host.should.equal(oldData.host)
                                newData.port.should.equal(oldData.port)
                                done()
                            }) 
                        },
                        function (rc,error,stat,data){
                            oldData = JSON.parse(data)
                        })
                        bqClient.shutdown()
                        bqClient = bqc.createClusterClient(bqClientConfig)
                        bqClient.on("ready",function(){
                            bqClient.postMessage("testTopic",{msg:"test1"},function(err,key){
                            })
                        })
                    })
                })
           })
       })
        */
       it("should ignore force down status",function(done){
            zk.a_set("/bq/clusters/test/nodes/redis2",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"FORCEDOWN"}),-1,function(rc, err,stat){
                setTimeout(function(){
                    bqClient.postMessage("testTopic",{msg:"test1"},function(err,key){
                        bqClient.postMessage("testTopic",{msg:"test2"},function(err,key){
                            bqClient.postMessage("testTopic",{msg:"test3"},function(err,key){
                                bqClient.postMessage("testTopic",{msg:"test4"},function(err,key){
                                    redisClient1.execute("get","topics:testTopic:head",function(err,data){
                                        should.not.exist(err)
                                        should.exist(data)
                                        data.should.equal(""+4)
                                        done()
                                    })
                                })
                            })
                        })
                    })
                },200)
            })
       })
       it("should ignore read_only status",function(done){
            zk.a_set("/bq/clusters/test/nodes/redis2",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"UP","read_only":true}),-1,function(rc, err,stat){
                setTimeout(function(){
                    bqClient.postMessage("testTopic",{msg:"test1"},function(err,key){
                        bqClient.postMessage("testTopic",{msg:"test2"},function(err,key){
                            bqClient.postMessage("testTopic",{msg:"test3"},function(err,key){
                                bqClient.postMessage("testTopic",{msg:"test4"},function(err,key){
                                    redisClient1.execute("get","topics:testTopic:head",function(err,data){
                                        should.not.exist(err)
                                        should.exist(data)
                                        data.should.equal(""+4)
                                        done()
                                    })
                                })
                            })
                        })
                    })
                },200)
            })
       })

    })
    describe("#getMessage",function(){
        beforeEach(function(done){
            bqClient.createTopic("testTopic",function(err){
                bqClient.createConsumerGroup("testTopic","testGroup",function(err){
                    should.not.exist(err)
                    done()

                })
            })
        })

        it("should generate and add a recipientCallback to the returned message",function(done){
            //because get message using round-robin
            bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,key){
                bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,key){
                    bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,key){
                        bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                            should.not.exist(err)
                            should.exist(data)
                            data.should.have.property("uid")
                            data.should.have.property("recipientCallback")
                            done()
                        })
                    })
                })
           })
        })
        it("should get node Id",function(done){
            //because get message using round-robin
            bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,key){
                bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,key){
                    bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,key){
                        bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                            should.not.exist(err)
                            should.exist(data)
                            data.should.have.property("nodeId")
                            done()
                        })
                    })
                })
           })
        })

        it("should balance the gets throw all nodes",function(done){
            bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,data){
                bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,data){
                    bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                            should.not.exist(err)
                            should.exist(data)
                            data.should.have.property("uid")
                            data.should.have.property("nodeId")
                            data.should.have.property("recipientCallback")
                        bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                            should.not.exist(err)
                            should.exist(data)
                            data.should.have.property("uid")
                            data.should.have.property("nodeId")
                            data.should.have.property("recipientCallback")
                            bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                                should.not.exist(err)
                                should.not.exist(data)
                                done()
                            })
                        })
                    })
                })
           })

        })
        it("should enable get message from specific nodes",function(done){
            bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,data){
                bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,data){
                    bqClient.getMessageFromNode("redis1","testTopic","testGroup",undefined,function(err,data){
                            should.not.exist(err)
                            should.exist(data)
                            data.should.have.property("uid")
                            data.should.have.property("nodeId")
                            data.nodeId.should.equal("redis1");
                            data.should.have.property("recipientCallback")
                        bqClient.getMessageFromNode("redis2","testTopic","testGroup",undefined,function(err,data){
                            should.not.exist(err)
                            should.exist(data)
                            data.should.have.property("uid")
                            data.should.have.property("nodeId")
                            data.nodeId.should.equal("redis2");
                            data.should.have.property("recipientCallback")
                            bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                                should.not.exist(err)
                                should.not.exist(data)
                                done()
                            })
                        })
                    })
                })
           })
        })

        it("should read messages from read_only nodes",function(done){
            bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,data){
                bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,data){
                   zk.a_set("/bq/clusters/test/nodes/redis2",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"UP","read_only":"true"}),-1,function(rc, err,stat){
                      process.nextTick(function(){
                        bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                                should.not.exist(err)
                                should.exist(data)
                                data.should.have.property("uid")
                                data.should.have.property("recipientCallback")
                                bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                                    should.not.exist(err)
                                    should.exist(data)
                                    data.should.have.property("uid")
                                    data.should.have.property("recipientCallback")
                                    bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                                        should.not.exist(err)
                                        should.not.exist(data)
                                        done()
                                    })
                                })
                            })
                        })
                    })
                })
            })
        })

        it("should run ok if a node is down",function(done){
            bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,data){
                bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,data){
                    zk.a_set("/bq/clusters/test/nodes/redis2",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"DOWN"}),-1,function(rc, err,stat){
                        rc.should.equal(0)
                         bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                            should.not.exist(err)
                            should.exist(data)
                            data.should.have.property("uid")
                            data.should.have.property("recipientCallback")
                            done()
                        })
                    })
           
                })
            })
        })

        it("should run ok if a all nodes are down",function(done){
            bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,data){
                bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,data){
                    zk.a_set("/bq/clusters/test/nodes/redis1",JSON.stringify({"host":"127.0.0.1","port":6379,"errors":0,"status":"DOWN"}),-1,function(rc, err,stat){
                        zk.a_set("/bq/clusters/test/nodes/redis2",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"DOWN"}),-1,function(rc, err,stat){
                            rc.should.equal(0)
                            setTimeout(function(){
                                bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                                    should.not.exist(data)
                                    done()
                                })
                            },100)
                        })
                    })
                })
            })
        }) 

        it("should get the uid generated at post instance",function(done){
            bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,key){
                bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,key2){
                    var uid = key.uid
                    bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                        should.not.exist(err)
                        should.exist(data)
                        data.uid.should.equal(uid)
                        done()
                    })
                })
           })

        })
        it("should return undefined if no message found",function(done){
            redisClient1.execute("set","topics:testTopic:head",0,function(err,data){
                redisClient2.execute("set","topics:testTopic:head",0,function(err,data){
                    bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                        should.not.exist(err)
                        should.not.exist(data)
                        done()
                    })
                })
            })
        })
        it("should return undefined if error found",function(done){
            bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                should.not.exist(data)
                done()
            })
        })

        it("should fail if the consumer group doesn't exist",function(done){
            redisClient1.execute("set","topics:testTopic:head",0,function(err,data){
                redisClient2.execute("set","topics:testTopic:head",0,function(err,data){
                    bqClient.getMessage("testTopic","testGroup-no-exist",undefined,function(err,data){
                        should.exist(err)
                        done()
                    })
               })
           })
        })

        it("should ignore down status",function(done){
             bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,data){
                bqClient.postMessage("testTopic",{msg:"testMessage"},function(err,data){
                   zk.a_set("/bq/clusters/test/nodes/redis2",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"FORCEDOWN"}),-1,function(rc, err,stat){
                      setTimeout(function(){
                        bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                                should.not.exist(err)
                                should.exist(data)
                                data.should.have.property("uid")
                                data.should.have.property("recipientCallback")
                                bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                                    should.not.exist(err)
                                    should.not.exist(data)
                                    done()
                                })
                            })
                        },200)
                    })
                })
            })
        })
    })

    describe("ack",function(){
        beforeEach(function(done){
            bqClient.createTopic("testTopic",function(err){
                bqClient.createConsumerGroup("testTopic","testGroup",function(err){
                    should.not.exist(err)
                    done()
                })
            })
        })
        it("should receive the recipientCallback ack the message",function(done){
            bqClient.postMessage("testTopic",{msg:"testMessage"},function(err){
                bqClient.postMessage("testTopic",{msg:"testMessage"},function(err){
                    bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                        var recipientCallback = data.recipientCallback
                        var recipientData = bqClient.decodeRecipientCallback(recipientCallback)
                        var client
                        if(recipientData.nodeId == "redis1"){
                            client = redisClient1
                        }else{
                            client = redisClient2
                        }
                        client.execute("zrangebyscore","topics:testTopic:consumers:testGroup:processing","-inf","+inf",function(err,data){
                            should.not.exist(err)
                            should.exist(data)
                            data.should.have.length(1)
                            bqClient.ackMessage("testTopic","testGroup",recipientCallback,function(err){
                                client.execute("zrangebyscore","topics:testTopic:consumers:testGroup:processing","-inf","+inf",function(err,data){
                                    should.not.exist(err)
                                    should.not.exist(err)
                                    should.exist(data)
                                    data.should.have.length(0)
                                    done()
                                })
                            })
                        })
                    })
                })
            })
        })
        it("should fail if the target node is down",function(done){
             bqClient.postMessage("testTopic",{msg:"testMessage"},function(err){
                bqClient.postMessage("testTopic",{msg:"testMessage"},function(err){
                    bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                        var recipientCallback = data.recipientCallback
                        var recipientData = bqClient.decodeRecipientCallback(recipientCallback)
                        zk.a_set("/bq/clusters/test/nodes/"+recipientData.nodeId,JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"DOWN"}),-1,function(rc, err,stat){
                            setTimeout(function(){
                                bqClient.ackMessage("testTopic","testGroup",recipientData.id,function(err){
                                    should.exist(err)
                                    done()
                                })
                            },50)
                        })
                    })
                })
             })
        })
    })

    describe("fail",function(){
        beforeEach(function(done){
            bqClient.createTopic("testTopic",function(err){
                bqClient.createConsumerGroup("testTopic","testGroup",function(err){
                    should.not.exist(err)
                    done()
                })
            })
        })

        it("should fail the message using the recipientCallback",function(done){
            bqClient.postMessage("testTopic",{msg:"testMessage"},function(err){
                bqClient.postMessage("testTopic",{msg:"testMessage"},function(err){
                    bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                        should.not.exist(err)
                        var recipientCallback = data.recipientCallback
                        var recipientData = bqClient.decodeRecipientCallback(recipientCallback)
                        var client
                        if(recipientData.nodeId == "redis1"){
                            client = redisClient1
                        }else{
                            client = redisClient2
                        }
                        client.execute("lrange","topics:testTopic:consumers:testConsumer:fails",0,-1,function(err,data){
                            should.not.exist(err)
                            should.exist(data)
                            data.should.have.lengthOf(0)
                            bqClient.failMessage("testTopic","testGroup",recipientCallback,function(err){
                                should.not.exist(err)
                                client.execute("lrange","topics:testTopic:consumers:testGroup:fails",0,-1,function(err,data){
                                    should.not.exist(err)
                                    should.exist(data)
                                    data.should.have.lengthOf(1)
                                    done()
                                }) 
                            })
                        })
                    })
                })
            })
        })
        it("should fail if the target node is down",function(done){
             bqClient.postMessage("testTopic",{msg:"testMessage"},function(err){
                bqClient.postMessage("testTopic",{msg:"testMessage"},function(err){
                    bqClient.getMessage("testTopic","testGroup",undefined,function(err,data){
                        var recipientCallback = data.recipientCallback
                        var recipientData = bqClient.decodeRecipientCallback(recipientCallback)
                        zk.a_set("/bq/clusters/test/nodes/"+recipientData.nodeId,JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"DOWN"}),-1,function(rc, err,stat){
                            setTimeout(function(){
                                bqClient.failMessage("testTopic","testGroup",recipientData.id,function(err){
                                    should.exist(err)
                                    done()
                                })
                            },50)
                        })
                    })
                })
             })

        })
   })
   
   describe("#listTopics",function(done){
       it("should list all the topics created into zookeeper",function(done){
           bqClient.listTopics(function(data){
               should.exist(data)
               data.should.have.lengthOf(0)
               bqClient.createTopic("testTopic",function(err){
                   should.not.exist(err)
                   bqClient.listTopics(function(data){
                   should.exist(data)
                   data.should.have.lengthOf(1)
                   done()
                  })
              })
           })
       })
   })
   describe("#getConsumerGroups",function(done){
        beforeEach(function(done){
            bqClient.createTopic("testTopic",function(err){
                should.not.exist(err)
                done()
            })
        })

        it("should get the consumer group list for a topic",function(done){
            bqClient.getConsumerGroups("testTopic",function(err,data){
                should.not.exist(err)
                data.should.be.empty
                bqClient.createConsumerGroup("testTopic","testConsumer",function(err){
                    should.not.exist(err)
                    bqClient.getConsumerGroups("testTopic",function(err,data){
                        should.not.exist(err)
                        data.should.include("testConsumer")
                        data.should.have.length(1)
                        done()
                    })
                })
            })
        })
        it("should fail if the topic doesn't exist",function(done){
            bqClient.getConsumerGroups("testTopic-noExist",function(err,data){
                should.exist(err)
                done()
            })
        })

   })

    describe("#stats",function(done){
        beforeEach(function(done){
           bqClient.createTopic("testTopic",function(err){
               bqClient.createConsumerGroup("testTopic","testConsumer",function(err){
                  should.not.exist(err)
                    done()
               })
           })
        })
        it("should return the stats from all redis clients",function(done){
            bqClient.getConsumerStats("testTopic","testConsumer",function(err,data){
                should.not.exist(err)
                should.exist(data)
                data.should.have.property("fails")
                data.should.have.property("processing")
                data.should.have.property("lag")
                data.fails.should.equal(0)
                data.lag.should.equal(0)
                data.processing.should.equal(0)
                bqClient.postMessage("testTopic",{msg:"test2"},function(err,key){
                    bqClient.postMessage("testTopic",{msg:"test2"},function(err,key){
                        bqClient.getConsumerStats("testTopic","testConsumer",function(err,data){
                            should.not.exist(err)
                            should.exist(data)
                            data.should.have.property("fails")
                            data.should.have.property("processing")
                            data.should.have.property("lag")
                            data.fails.should.equal(0)
                            data.lag.should.equal(2)
                            data.processing.should.equal(0)
                            bqClient.getMessage("testTopic","testConsumer",undefined,function(err,msg){
                                 bqClient.getConsumerStats("testTopic","testConsumer",function(err,data){
                                    should.not.exist(err)
                                    should.exist(data)
                                    data.should.have.property("fails")
                                    data.should.have.property("processing")
                                    data.should.have.property("lag")
                                    data.fails.should.equal(0)
                                    data.lag.should.equal(1)
                                    data.processing.should.equal(1)
                                    bqClient.failMessage("testTopic","testConsumer",msg.recipientCallback,function(err){
                                        bqClient.getConsumerStats("testTopic","testConsumer",function(err,data){
                                            should.not.exist(err)
                                            should.exist(data)
                                            data.should.have.property("fails")
                                            data.should.have.property("processing")
                                            data.should.have.property("lag")
                                            data.fails.should.equal(1)
                                            data.lag.should.equal(1)
                                            data.processing.should.equal(0)
                                            done()
                                        })
                                    })
                                })                                  
                            })
                        })
                    })
                })
            }) 
        })

        it("should get topic ttl",function(done){
            bqClient.createTopic("testTopic1",1,function(err){
                should.not.exist(err)
                bqClient.getTopicTtl("testTopic1",function(err,data){
                    should.not.exist(err)
                    should.exist(data)
                    data.should.equal(""+1)
                    bqClient.createTopic("testTopic2",2,function(err){
                        should.not.exist(err)
                        bqClient.getTopicTtl("testTopic2",function(err,data){
                            should.not.exist(err)
                            should.exist(data)
                            data.should.equal(""+2)
                            done()
                        })
                    })
                })
            })
        })
    })
   describe("background",function(){
       it("should collect stats in file",function(done){
           bqClient.shutdown() 
           var bqClientConfig = {
               "zk":zk,
               "refreshTime":500,
               "zkClusterPath":clusterPath,
               "createJournalClientFunction":bj.createJournalClient,
               "createNodeClientFunction":bq.createClient,
               "statsInterval":50,
               "statsFile":"/tmp/bigqueueStats.log"
            }

            var dirs = fs.readdirSync("/tmp")
            if(dirs.lastIndexOf("bigqueueStats.log") != -1){
                fs.unlinkSync("/tmp/bigqueueStats.log")
            }
            bqc.statsInit = false
            bqClient = bqc.createClusterClient(bqClientConfig)
            bqClient.on("ready",function(){
               bqClient.postMessage("testTopic",{msg:"test1"},function(err,key){
                    bqClient.postMessage("testTopic",{msg:"test2"},function(err,key){
                        bqClient.postMessage("testTopic",{msg:"test3"},function(err,key){
                            bqClient.postMessage("testTopic",{msg:"test4"},function(err,key){
                                setTimeout(function(){
                                    var dirs = fs.readdirSync("/tmp")
                                    dirs.lastIndexOf("bigqueueStats.log").should.not.equal(-1)
                                    done()
                                },210)
                            })
                        })
                    })
               })
            })
       })
       it("should re-sink nodes from zookeeper periodically",function(done){
           var client = bqClient.getNodeById("redis1")
           client.data.status.should.equal("UP")
           bqClient.nodeMonitor.running=false
           zk.a_set("/bq/clusters/test/nodes/redis1",JSON.stringify({"host":"127.0.0.1","port":6380,"errors":0,"status":"DOWN"}),-1,function(rc, err,stat){
                bqClient.nodeMonitor.running=true
                rc.should.equal(0)
                client.data.status.should.equal("UP")
                setTimeout(function(){
                    client.data.status.should.equal("DOWN")
                    done()
                },1000)
           })
       })
       it("should get an error if all execution where timeout",function(done){
        bqClient.withSomeClient(
                function(clusterNode,monitor){
                    setTimeout(function(){
                        monitor.emit(undefined,{"id":1})
                    },130)
                },
                function(err,key){
                    should.exist(err)
                    should.not.exist(key)
                    done()
                }
           )
        })

     it("should ignore timed out execs",function(done){
      var cont = 1
          bqClient.withSomeClient(
            function(clusterNode,monitor){
                if(cont == 2)
                    return monitor.emit(undefined,{"id":cont})
                setTimeout(function(){
                    monitor.emit(undefined,{"id":cont})
                },130)
                cont++
            },
            function(err,key){
                should.not.exist(err)
                should.exist(key)
                key.id.should.equal(2)
                done()
        })
     })
    })
})
