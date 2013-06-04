module Camel {
  export function DebugRouteController($scope, workspace:Workspace, jolokia) {
    // ignore the cached stuff in camel.ts as it seems to bork the node ids for some reason...
    $scope.ignoreRouteXmlNode = true;

    $scope.startDebugging = () => {
      setDebugging(true);
    };

    $scope.stopDebugging = () => {
      setDebugging(false);
    };

    $scope.$on("$routeChangeSuccess", function (event, current, previous) {
      // lets do this asynchronously to avoid Error: $digest already in progress
      setTimeout(reloadData, 50);
    });

    $scope.$on("camel.diagram.selectedNodeId", (event, value) => {
      $scope.selectedDiagramNodeId = value;
      //console.log("the selected diagram node is now " + $scope.selectedDiagramNodeId);
      updateBreakpointFlag();
    });

    $scope.$on("camel.diagram.layoutComplete", (event, value) => {
      updateBreakpointIcons();
    });

    $scope.$watch('workspace.selection', function () {
      if (workspace.moveIfViewInvalid()) return;
      reloadData();
    });

    $scope.addBreakpoint = () => {
      var mbean = getSelectionCamelDebugMBean(workspace);
      if (mbean && $scope.selectedDiagramNodeId) {
        console.log("adding breakpoint on " + $scope.selectedDiagramNodeId);
        jolokia.execute(mbean, "addBreakpoint", $scope.selectedDiagramNodeId, onSuccess(debuggingChanged));
      }
    };

    $scope.removeBreakpoint = () => {
      var mbean = getSelectionCamelDebugMBean(workspace);
      if (mbean && $scope.selectedDiagramNodeId) {
        console.log("removing breakpoint on " + $scope.selectedDiagramNodeId);
        jolokia.execute(mbean, "removeBreakpoint", $scope.selectedDiagramNodeId, onSuccess(debuggingChanged));
      }
    };

    $scope.resume = () => {
      var mbean = getSelectionCamelDebugMBean(workspace);
      if (mbean) {
        jolokia.execute(mbean, "resumeAll", onSuccess(clearStopped));
      }
    };

    $scope.suspend = () => {
      var mbean = getSelectionCamelDebugMBean(workspace);
      if (mbean) {
        jolokia.execute(mbean, "suspendAll", onSuccess(stepChanged));
      }
    };

    $scope.step = () => {
      var mbean = getSelectionCamelDebugMBean(workspace);
      var stepNodes = $scope.suspendedBreakpoints;
      if (stepNodes && stepNodes.length) {
        var stepNode = stepNodes[0];
        if (stepNodes.length > 1 && isSuspendedAt($scope.selectedDiagramNodeId)) {
          // TODO should consider we stepping from different nodes based on the call thread or selection?
          stepNode = $scope.selectedDiagramNodeId;
        }
        if (mbean && stepNode) {
          console.log("stepping from breakpoint on " + stepNode);
          jolokia.execute(mbean, "stepBreakpoint(java.lang.String)", stepNode, onSuccess(stepChanged));
        }
      }
    };


    function reloadData() {
      $scope.debugging = false;
      var mbean = getSelectionCamelDebugMBean(workspace);
      if (mbean) {
        $scope.debugging = jolokia.getAttribute(mbean, "Enabled", onSuccess(null));
        if ($scope.debugging) {
          jolokia.execute(mbean, "getBreakpoints", onSuccess(onBreakpoints));
          // get the breakpoints...
          $scope.graphView = "app/camel/html/routes.html";
          //$scope.tableView = "app/camel/html/browseMessages.html";

          Core.register(jolokia, $scope, {
            type: 'exec', mbean: mbean,
            operation: 'getDebugCounter'}, onSuccess(onBreakpointCounter));
        } else {
          $scope.graphView = null;
          $scope.tableView = null;
        }
      }
    }

    function onBreakpointCounter(response) {
      var counter = response.value;
      if (counter && counter !== $scope.breakpointCounter) {
        console.log("breakpoint counter is now " + counter);
        $scope.breakpointCounter = counter;
        loadCurrentStack();
      }
    }

    /**
     * lets load current 'stack' of which breakpoints are active
     * and what is the current message content
     */
    function loadCurrentStack() {
      var mbean = getSelectionCamelDebugMBean(workspace);
      if (mbean) {
        jolokia.execute(mbean, "getSuspendedBreakpointNodeIds", onSuccess(onSuspendedBreakpointNodeIds));

        // TODO load the current messages!
      }
    }

    function clearStopped() {
      loadCurrentStack();
      $scope.suspendedBreakpoints = [];
      $scope.stopped = false;
      Core.$apply($scope);
    }

    function onSuspendedBreakpointNodeIds(response) {
      $scope.suspendedBreakpoints = response;
      $scope.stopped = response && response.length;
      console.log("got suspended " + JSON.stringify(response) + " stopped: " + $scope.stopped);
      updateBreakpointIcons();
      Core.$apply($scope);
    }

    /**
     * Returns true if the execution is currently suspended at the given node
     */
    function isSuspendedAt(nodeId) {
      return containsNodeId($scope.suspendedBreakpoints, nodeId);
    }

    function onBreakpoints(response) {
      $scope.breakpoints = response;
      console.log("got breakpoints " + JSON.stringify(response));
      updateBreakpointFlag();

      // update the breakpoint icons...
      var nodes = getDiagramNodes();
      if (nodes.length) {
        updateBreakpointIcons(nodes);
      }
      Core.$apply($scope);
    }

    /**
     * Returns true if there is a breakpoint set at the given node id
     */
    function isBreakpointSet(nodeId) {
      return containsNodeId($scope.breakpoints, nodeId);
    }

    function updateBreakpointFlag() {
      $scope.hasBreakpoint = isBreakpointSet($scope.selectedDiagramNodeId)
    }

    function containsNodeId(breakpoints, nodeId) {
      return nodeId && breakpoints && breakpoints.some(nodeId);
    }


    function getDiagramNodes() {
      var svg = d3.select("svg");
      return svg.selectAll("g .node");
    }

    var breakpointImage = url("/app/camel/img/debug/breakpoint.gif");
    var suspendedBreakpointImage = url("/app/camel/img/debug/breakpoint-suspended.gif");

    function updateBreakpointIcons(nodes = getDiagramNodes()) {
      nodes.each(function (object) {
        // add breakpoint icon
        var nodeId = object.cid;
        var thisNode = d3.select(this);
        var icons = thisNode.selectAll("image.breakpoint");
        var isSuspended = isSuspendedAt(nodeId);
        var isBreakpoint = isBreakpointSet(nodeId);
        if (isBreakpoint || isSuspended) {
          var imageUrl = isSuspended ? suspendedBreakpointImage : breakpointImage;
          // lets add an icon image if we don't already have one
          if (!icons.length || !icons[0].length) {
            thisNode.append("image")
                    .attr("xlink:href", function (d) {
                      return imageUrl;
                    })
                    .attr("class", "breakpoint")
                    .attr("x", -12)
                    .attr("y", -20)
                    .attr("height", 24)
                    .attr("width", 24);
          } else {
            icons.attr("xlink:href", function (d) {
              return imageUrl;
            });
          }
        } else {
          icons.remove();
        }
      });
    }


    function debuggingChanged(response) {
      reloadData();
      Core.$apply($scope);
    }

    function stepChanged(response) {
      // TODO lets reload everything, though probably just polling the current
      // paused state is enough...
      reloadData();
      Core.$apply($scope);
    }

    function setDebugging(flag:Boolean) {
      var mbean = getSelectionCamelDebugMBean(workspace);
      if (mbean) {
        var method = flag ? "enableDebugger" : "disableDebugger";
        jolokia.execute(mbean, method, onSuccess(debuggingChanged));
      }
    }
  }
}