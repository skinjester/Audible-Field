{
	"patcher" : {
		"fileversion" : 1,
		"appversion" : {
			"major" : 9,
			"minor" : 1,
			"revision" : 5,
			"architecture" : "x64",
			"modernui" : 1
		},
		"classnamespace" : "box",
		"rect" : [ 80.0, 80.0, 760.0, 580.0 ],
		"openinpresentation" : 0,
		"default_fontsize" : 12.0,
		"default_fontname" : "Arial",
		"boxes" : [
			{
				"box" : {
					"id" : "obj-title",
					"maxclass" : "comment",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 18.0, 16.0, 520.0, 20.0 ],
					"text" : "EchoScape web bridge — keep this patch open with EchoScape-demo"
				}
			},
			{
				"box" : {
					"id" : "obj-help",
					"linecount" : 4,
					"maxclass" : "comment",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 18.0, 40.0, 520.0, 62.0 ],
					"text" : "send/receive names are global, so this taps the mixer without editing the main patch. Run the Node server, then open http://localhost:8080. OSC goes to 127.0.0.1:9000 as /mixer/xy, /mixer/touch, /mixer/dpad."
				}
			},
			{
				"box" : {
					"id" : "obj-rx",
					"maxclass" : "newobj",
					"numinlets" : 0,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 18.0, 128.0, 91.0, 22.0 ],
					"text" : "r x_value_out"
				}
			},
			{
				"box" : {
					"id" : "obj-ry",
					"maxclass" : "newobj",
					"numinlets" : 0,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 132.0, 128.0, 91.0, 22.0 ],
					"text" : "r y_value_out"
				}
			},
			{
				"box" : {
					"id" : "obj-pak-xy",
					"maxclass" : "newobj",
					"numinlets" : 2,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 18.0, 164.0, 55.0, 22.0 ],
					"text" : "pak 0. 0."
				}
			},
			{
				"box" : {
					"id" : "obj-lim-xy",
					"maxclass" : "newobj",
					"numinlets" : 1,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 18.0, 196.0, 76.0, 22.0 ],
					"text" : "speedlim 16"
				}
			},
			{
				"box" : {
					"id" : "obj-pre-xy",
					"maxclass" : "newobj",
					"numinlets" : 1,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 18.0, 228.0, 97.0, 22.0 ],
					"text" : "prepend /mixer/xy"
				}
			},
			{
				"box" : {
					"id" : "obj-tx",
					"maxclass" : "newobj",
					"numinlets" : 0,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 260.0, 128.0, 113.0, 22.0 ],
					"text" : "r touchpad_x"
				}
			},
			{
				"box" : {
					"id" : "obj-ty",
					"maxclass" : "newobj",
					"numinlets" : 0,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 388.0, 128.0, 113.0, 22.0 ],
					"text" : "r touchpad_y"
				}
			},
			{
				"box" : {
					"id" : "obj-pak-touch",
					"maxclass" : "newobj",
					"numinlets" : 2,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 260.0, 164.0, 55.0, 22.0 ],
					"text" : "pak 0. 0."
				}
			},
			{
				"box" : {
					"id" : "obj-lim-touch",
					"maxclass" : "newobj",
					"numinlets" : 1,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 260.0, 196.0, 76.0, 22.0 ],
					"text" : "speedlim 16"
				}
			},
			{
				"box" : {
					"id" : "obj-pre-touch",
					"maxclass" : "newobj",
					"numinlets" : 1,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 260.0, 228.0, 118.0, 22.0 ],
					"text" : "prepend /mixer/touch"
				}
			},
			{
				"box" : {
					"id" : "obj-du",
					"maxclass" : "newobj",
					"numinlets" : 0,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 18.0, 292.0, 85.0, 22.0 ],
					"text" : "r dpad_up"
				}
			},
			{
				"box" : {
					"id" : "obj-dd",
					"maxclass" : "newobj",
					"numinlets" : 0,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 132.0, 292.0, 100.0, 22.0 ],
					"text" : "r dpad_down"
				}
			},
			{
				"box" : {
					"id" : "obj-dl",
					"maxclass" : "newobj",
					"numinlets" : 0,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 260.0, 292.0, 87.0, 22.0 ],
					"text" : "r dpad_left"
				}
			},
			{
				"box" : {
					"id" : "obj-dr",
					"maxclass" : "newobj",
					"numinlets" : 0,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 376.0, 292.0, 95.0, 22.0 ],
					"text" : "r dpad_right"
				}
			},
			{
				"box" : {
					"id" : "obj-pre-du",
					"maxclass" : "newobj",
					"numinlets" : 1,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 18.0, 324.0, 132.0, 22.0 ],
					"text" : "prepend /mixer/dpad up"
				}
			},
			{
				"box" : {
					"id" : "obj-pre-dd",
					"maxclass" : "newobj",
					"numinlets" : 1,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 132.0, 356.0, 150.0, 22.0 ],
					"text" : "prepend /mixer/dpad down"
				}
			},
			{
				"box" : {
					"id" : "obj-pre-dl",
					"maxclass" : "newobj",
					"numinlets" : 1,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 260.0, 324.0, 140.0, 22.0 ],
					"text" : "prepend /mixer/dpad left"
				}
			},
			{
				"box" : {
					"id" : "obj-pre-dr",
					"maxclass" : "newobj",
					"numinlets" : 1,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 376.0, 356.0, 148.0, 22.0 ],
					"text" : "prepend /mixer/dpad right"
				}
			},
			{
				"box" : {
					"id" : "obj-udp",
					"maxclass" : "newobj",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 18.0, 412.0, 148.0, 22.0 ],
					"text" : "udpsend 127.0.0.1 9000"
				}
			},
			{
				"box" : {
					"id" : "obj-lb",
					"maxclass" : "newobj",
					"numinlets" : 1,
					"numoutlets" : 1,
					"outlettype" : [ "bang" ],
					"patching_rect" : [ 18.0, 448.0, 58.0, 22.0 ],
					"text" : "loadbang"
				}
			},
			{
				"box" : {
					"id" : "obj-status",
					"maxclass" : "message",
					"numinlets" : 2,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 18.0, 480.0, 360.0, 22.0 ],
					"text" : "EchoScape web bridge sending OSC to 127.0.0.1:9000"
				}
			},
			{
				"box" : {
					"id" : "obj-print",
					"maxclass" : "newobj",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 18.0, 512.0, 34.0, 22.0 ],
					"text" : "print"
				}
			},
			{
				"box" : {
					"id" : "obj-xy-num",
					"maxclass" : "comment",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 18.0, 108.0, 180.0, 20.0 ],
					"text" : "processed mixer (use this)"
				}
			},
			{
				"box" : {
					"id" : "obj-touch-num",
					"maxclass" : "comment",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 260.0, 108.0, 200.0, 20.0 ],
					"text" : "raw touchpad (no d-pad snaps)"
				}
			}
		],
		"lines" : [
			{ "patchline" : { "source" : [ "obj-rx", 0 ], "destination" : [ "obj-pak-xy", 0 ] } },
			{ "patchline" : { "source" : [ "obj-ry", 0 ], "destination" : [ "obj-pak-xy", 1 ] } },
			{ "patchline" : { "source" : [ "obj-pak-xy", 0 ], "destination" : [ "obj-lim-xy", 0 ] } },
			{ "patchline" : { "source" : [ "obj-lim-xy", 0 ], "destination" : [ "obj-pre-xy", 0 ] } },
			{ "patchline" : { "source" : [ "obj-pre-xy", 0 ], "destination" : [ "obj-udp", 0 ] } },
			{ "patchline" : { "source" : [ "obj-tx", 0 ], "destination" : [ "obj-pak-touch", 0 ] } },
			{ "patchline" : { "source" : [ "obj-ty", 0 ], "destination" : [ "obj-pak-touch", 1 ] } },
			{ "patchline" : { "source" : [ "obj-pak-touch", 0 ], "destination" : [ "obj-lim-touch", 0 ] } },
			{ "patchline" : { "source" : [ "obj-lim-touch", 0 ], "destination" : [ "obj-pre-touch", 0 ] } },
			{ "patchline" : { "source" : [ "obj-pre-touch", 0 ], "destination" : [ "obj-udp", 0 ] } },
			{ "patchline" : { "source" : [ "obj-du", 0 ], "destination" : [ "obj-pre-du", 0 ] } },
			{ "patchline" : { "source" : [ "obj-dd", 0 ], "destination" : [ "obj-pre-dd", 0 ] } },
			{ "patchline" : { "source" : [ "obj-dl", 0 ], "destination" : [ "obj-pre-dl", 0 ] } },
			{ "patchline" : { "source" : [ "obj-dr", 0 ], "destination" : [ "obj-pre-dr", 0 ] } },
			{ "patchline" : { "source" : [ "obj-pre-du", 0 ], "destination" : [ "obj-udp", 0 ] } },
			{ "patchline" : { "source" : [ "obj-pre-dd", 0 ], "destination" : [ "obj-udp", 0 ] } },
			{ "patchline" : { "source" : [ "obj-pre-dl", 0 ], "destination" : [ "obj-udp", 0 ] } },
			{ "patchline" : { "source" : [ "obj-pre-dr", 0 ], "destination" : [ "obj-udp", 0 ] } },
			{ "patchline" : { "source" : [ "obj-lb", 0 ], "destination" : [ "obj-status", 0 ] } },
			{ "patchline" : { "source" : [ "obj-status", 0 ], "destination" : [ "obj-print", 0 ] } }
		]
	}
}
