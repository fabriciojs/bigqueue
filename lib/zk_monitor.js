var ZK = require("zookeeper"),
    events = require("events"),
    log = require('node-logging')
/**
 * It's a simple way to monitor a zk path 
 * removing the zookeeper logic from the main code
 * at the start the nodeAdded method will be called one time per child node
 */

exports = module.exports = ZKMonitor
function ZKMonitor(zkClient,callable){
    var self = this
    events.EventEmitter.call(this);
    this.zkClient = zkClient
    self.errorOcurs = false
    
    this.zkClient.on("error",function(){
        self.errorOcurs = true
    }) 
    
    this.callable = callable
    this.actualPath = {}
    this.running = true
}

ZKMonitor.prototype = new events.EventEmitter();

ZKMonitor.prototype.shutdown = function(){
    this.running = false
}

ZKMonitor.prototype.pathMonitor = function(path,shouldSubscribe,callback){
    var self = this
    this.first = true
    var subscribe = true
    var checkAndResponse = function(){
        if(callback)
            callback.apply(self,arguments)
    }
    if(shouldSubscribe != undefined)
        subscribe = shouldSubscribe
    if(!this.running)
        throw new Error("Monitor is not running")
    this.zkClient.a_exists(path,false,function(rc,err,stat){
        if(rc!=0){
            try{
                var err = "Path does not exist ["+path+"]"
                log.err(err)
                checkAndResponse(err)
                self.emit("error",err)
            }catch(e){}
            return;
        }
        if(self.actualPath[path] == undefined || subscribe){
            self.actualPath[path] = []
        }
        var onData = function(rc,error,childrens){
            if(self.running && childrens){
                self.updateChilds(path,childrens,subscribe)
                process.nextTick(function(){
                    checkAndResponse(undefined)
                })
            }
        }
        var onEvent = function(type,state,path){
            if(self.running)
                self.zkClient.aw_get_children(path,onEvent,onData)
        }
        if(subscribe){
            self.zkClient.aw_get_children(path,onEvent,onData)
        }else{
            self.zkClient.a_get_children(path,false,onData)
        }
         
    })
}

ZKMonitor.prototype.refresh = function(callback){
    var keys = Object.keys(this.actualPath)
    if(keys.length == 0 && callback)
        callback()
    var responses = 0    
    for(var i in keys){
        try{
            this.pathMonitor(keys[i],this.errorOcurs,function(err){
                responses++
                if(responses == keys.length && callback) 
                    callback()
            })
        }catch(e){}
    }
    this.errorOcurs = false
}

ZKMonitor.prototype.updateChilds = function(path,childrens){
    if(!this.running)
        return 
    var onGetEvent = function(type,state,path){
    }

    var pathData = this.actualPath[path] 
    var added = childrens.filter(function(element,index,array){
        return pathData.indexOf(element) < 0
    })
    
    var removed = pathData.filter(function(element,index,array){
        return childrens.indexOf(element) < 0
    })
    addAll(pathData,added)
    removeAll(pathData,removed)
    for(var r in removed){
        this.callable.nodeRemoved({"path":path, "node":removed[r]})
    }
    for(var a in added){
        new MonitoreableNode(this.zkClient,path,added[a],this.callable,this.running,this)
    }
    if(!this.shouldSubscribe){
        var existing = this.monitoredPaths(path).filter(function(element,index,array){
            return added.indexOf(element) < 0
        })
        for(var e in existing){
            new MonitoreableNode(this.zkClient,path,existing[e],this.callable,this.running,this,false)
        }
    }
}

ZKMonitor.prototype.monitoredPaths = function(path){
    return this.actualPath[path] || []
}

/**
 * Wraps per child get data logic
 */
function MonitoreableNode(zkClient,path,node,callable,running,father,shouldSubscribe){
    this.zkClient = zkClient
    this.path = path
    this.node = node
    this.callable = callable
    if(shouldSubscribe == undefined)
        this.shouldSubscribe = true
    else
        this.shouldSubscribe = shouldSubscribe
    var self = this
    var onGetEvent = function(type,state,path){
        if(father.running){
            self.zkClient.aw_get(self.path+"/"+self.node,onGetEvent,function(rc,error,stat,data){
                if(type == ZK.ZOO_CHANGED_EVENT && data){
                    self.callable.nodeDataChange({"path":self.path,"node":self.node,"data":data.toString('utf-8')})
                }
            })
        }
    }
    if(this.shouldSubscribe){
        this.zkClient.aw_get(this.path+"/"+this.node,onGetEvent,function(rc,error,stat,data){
           if(father.running){
               if(!data)
                   data = "{}"
               self.callable.nodeAdded({"path":self.path,"node":self.node,"data":data.toString('utf-8')})
           }
        })
    }else{
        this.zkClient.a_get(this.path+"/"+this.node,false,function(rc,error,stat,data){
           if(father.running){
               if(!data)
                   data = "{}"
               self.callable.nodeDataChange({"path":self.path,"node":self.node,"data":data.toString('utf-8')})
           }
        })

    }


}

addAll = function(orig, arr){
    for(var i in arr){
       orig.push(arr[i])
    }
}

removeAll = function(orig,remove){
    var idx = []
    for(var i in orig){
        if(remove.indexOf(orig[i])>=0){
            idx.push(i)
        }
    }
    for(var i in idx){
        orig.splice(idx[i],1)
    }
}

