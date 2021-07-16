import { Types, PluginValidateFn, PluginFunction } from '@graphql-codegen/plugin-helpers';
import { visit, GraphQLSchema, concatAST, Kind, FragmentDefinitionNode } from 'graphql';
import { LoadedFragment } from '@graphql-codegen/visitor-plugin-common';
import { PythonOperationsVisitor } from './visitor';
import { extname } from 'path';
import gql from 'graphql-tag';
import { PythonOperationsRawPluginConfig } from './config';
import { csharpKeywords } from '../../common/keywords';

const getImports = (config: PythonOperationsRawPluginConfig) => {
  return `
from typing import Any, List, Dict, Optional, Union, AsyncGenerator, Type
from dataclasses import dataclass
from dataclasses import asdict
from gql import gql, Client as GqlClient
from gql.transport.aiohttp import AIOHTTPTransport
${config.generateAsync ? 'from gql.transport.websockets import WebsocketsTransport' : ''}
from gql.transport.requests import RequestsHTTPTransport
from dacite import from_dict, Config
from enum import Enum
import websocket
import uuid
import json

keywords = [${csharpKeywords.map(s => `'${s}'`).join(', ')}]

def remove_empty(dict_or_list):
    if isinstance(dict_or_list, dict):
        new_dict = {}
        for key, value in dict_or_list.items():
            if value != {}:
              newkey = key
              if key in keywords:
                newkey = '_' + key
              new_dict[newkey] = remove_empty(value)  
        return new_dict
    elif isinstance(dict_or_list, list):
        delete_indices = []
        for idx, object_in_list in enumerate(dict_or_list):
            if object_in_list == {}:
                delete_indices.append(idx)
            else:
              dict_or_list[idx] = remove_empty(object_in_list)
        for idx in sorted(delete_indices, reverse=True):
          del dict_or_list[idx]
        return dict_or_list
    else:
        return dict_or_list

def to_dict(obj):
  if isinstance(obj, dict):
    for k,v in obj.items():
      if v is None:
        del obj[k]
      else:
        obj[k] = to_dict(v)
    return obj
  elif isinstance(obj, list):
    new_list = []
    for objs in obj:
      if objs is not None:
        new_list.append(to_dict(objs))
    return new_list
  elif hasattr(type(obj), '__dataclass_fields__'):
    new_dict = {}
    for k,v in obj.__dict__.items():
      if v is not None:
        new_dict[k] = to_dict(v)
    return new_dict
  else:
    return obj


${
  !config.generateAsync
    ? `
# adapted from https://github.com/profusion/sgqlc/blob/master/sgqlc/endpoint/websocket.py
class WebsocketClient:
  def __init__(self, url, connection_payload, **ws_options):
    self.url = url
    self.connection_payload = connection_payload
    self.ws_options = ws_options
    self.keep_alives = ['ka']

  @staticmethod
  def generate_id() -> str:
      return str(uuid.uuid4())
  
  def _get_response(self, ws):
        '''Ignore any keep alive responses'''

        response = json.loads(ws.recv())
        while response['type'] in self.keep_alives:
            response = json.loads(ws.recv())
        return response
    
  def call(self, query: str, variables, operation_name):
    ws = websocket.create_connection(self.url,
                                          subprotocols=['graphql-ws'],
                                          **self.ws_options)
    try:
      init_id = self.generate_id()
      connection_setup_dict = {'type': 'connection_init', 'id': init_id}
      if self.connection_payload:
          connection_setup_dict['payload'] = self.connection_payload
      ws.send(json.dumps(connection_setup_dict))

      response = self._get_response(ws)
      if response['type'] != 'connection_ack':
          raise ValueError(
              f'Unexpected {response["type"]} '
              f'when waiting for connection ack'
          )
      # response does not always have an id
      if response.get('id', init_id) != init_id:
          raise ValueError(
              f'Unexpected id {response["id"]} '
              f'when waiting for connection ack'
          )

      query_id = self.generate_id()
      ws.send(json.dumps({'type': 'start',
                          'id': query_id,
                          'payload': {'query': query,
                                      'variables': variables,
                                      'operationName': operation_name}}))
      response = self._get_response(ws)
      while response['type'] != 'complete':
          if response['id'] != query_id:
              raise ValueError(
                  f'Unexpected id {response["id"]} '
                  f'when waiting for query results'
              )
          if response['type'] == 'data':
              yield response['payload']["data"]
          else:
              raise ValueError(f'Unexpected message {response} '
                                f'when waiting for query results')
          response = self._get_response(ws)

    finally:
        ws.close()
`
    : ''
}
`;
};

const getClient = (config: PythonOperationsRawPluginConfig) => {
  return `
class Client:
  def __init__(self, url: str, ws_url: str, headers: Optional[Dict[str, Any]] = None, ws_connection_payload: Optional[Dict[str, Any]] = None, secure: bool = True):

    if "://" in url or "://" in ws_url:
      raise ValueError("pass url/ws_url without scheme! Example: '127.0.0.1:8080/graphql'")
    
    http_url = ("https://" if secure else "http://") + url
    ws_url = ("wss://" if secure else "ws://") + ws_url
    ${
      config.generateAsync
        ? `

    self.__async_transport = AIOHTTPTransport(url=http_url, headers=headers, timeout=300)
    self.__async_client = GqlClient(transport=self.__async_transport, fetch_schema_from_transport=False, execute_timeout=300)

    self.__websocket_transport = WebsocketsTransport(url=ws_url, init_payload=headers)
    self.__websocket_client = GqlClient(transport=self.__websocket_transport, fetch_schema_from_transport=False)

    `
        : `
    self.__http_transport = AIOHTTPTransport(url=http_url, headers=headers, timeout=300)
    self.__client = GqlClient(transport=self.__http_transport, fetch_schema_from_transport=False, execute_timeout=300)

    self.__websocket_client = WebsocketClient(url=ws_url, connection_payload=ws_connection_payload)

    `
    }
  `;
};

export const plugin: PluginFunction<PythonOperationsRawPluginConfig> = (
  schema: GraphQLSchema,
  documents: Types.DocumentFile[],
  config
) => {
  const allAst = concatAST(documents.map(v => v.document));
  const allFragments: LoadedFragment[] = [
    ...(allAst.definitions.filter(d => d.kind === Kind.FRAGMENT_DEFINITION) as FragmentDefinitionNode[]).map(
      fragmentDef => ({
        node: fragmentDef,
        name: fragmentDef.name.value,
        onType: fragmentDef.typeCondition.name.value,
        isExternal: false,
      })
    ),
    ...(config.externalFragments || []),
  ];

  const visitor = new PythonOperationsVisitor(schema, allFragments, config, documents);
  const visitorResult = visit(allAst, { leave: visitor });
  const varAndMethodSep = '=$(§%/(=)$§(%=)$§=(%=§$)%/HGJDGSDG=()§§';
  const filteredReults = visitorResult.definitions.filter(t => typeof t === 'string');
  const vars: string[] = [];
  const methods: string[] = [];

  filteredReults.forEach(r => {
    const varAndMethod = r.split(varAndMethodSep, 2);
    vars.push(varAndMethod[0]);
    methods.push(varAndMethod[1]);
  });

  return {
    prepend: [],
    content: [getImports(config), ...vars, getClient(config), ...methods].filter(a => a).join('\n'),
  };
};

export const addToSchema = gql`
  directive @namedClient(name: String!) on OBJECT | FIELD
`;

export const validate: PluginValidateFn<any> = async (
  schema: GraphQLSchema,
  documents: Types.DocumentFile[],
  config,
  outputFile: string
) => {
  if (extname(outputFile) !== '.py') {
    throw new Error(`Plugin "python-operations" requires extension to be ".py"!`);
  }
};

export { PythonOperationsVisitor };
